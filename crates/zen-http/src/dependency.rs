//! Dependency-graph helpers for ordering dependent requests.
//!
//! Two resolvers are exposed:
//!
//! 1. [`DependencyResolver`] — cheap, synchronous, in-memory. Ignores
//!    cross-file dependencies. Used when the user picks a request that lives
//!    fully inside the currently-open file.
//! 2. [`CrossFileDependencyResolver`] — resolves both local and cross-file
//!    deps by talking to a shared [`FileRegistry`]. Returns the full chain
//!    of `HttpRequest` clones in topological order.

use crate::error::{CrossFileDependencyError, DependencyError, FileRegistryError};
use crate::registry::FileRegistry;
use ahash::{HashMap, HashSet};
use petgraph::algo::toposort;
use petgraph::graph::{DiGraph, NodeIndex};
use std::path::Path;
use zen_types::request::{DependencyRef, HttpRequest};

/// Identifier for a request that is unambiguous across files.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct QualifiedRequestId {
    /// Absolute, canonical file path.
    pub file_path: String,
    /// Request name.
    pub request_name: String,
}

impl QualifiedRequestId {
    /// New from explicit components.
    pub fn new(file_path: impl Into<String>, request_name: impl Into<String>) -> Self {
        Self {
            file_path: file_path.into(),
            request_name: request_name.into(),
        }
    }

    /// New from an [`HttpRequest`], if it has a known source file.
    pub fn from_request(request: &HttpRequest) -> Option<Self> {
        let file_path = request.source_file.as_ref()?;
        let name = request.name.clone().unwrap_or_else(|| request.id.clone());
        Some(Self::new(file_path.clone(), name))
    }
}

/// Local-only dependency resolver — fast path for single-file requests.
pub struct DependencyResolver {
    graph: DiGraph<String, ()>,
    nodes: HashMap<String, NodeIndex>,
}

impl DependencyResolver {
    /// Build the graph from a slice of requests.
    pub fn new(requests: &[HttpRequest]) -> Self {
        let mut graph = DiGraph::<String, ()>::new();
        let mut nodes: HashMap<String, NodeIndex> = HashMap::default();

        for req in requests {
            let id = req.name.clone().unwrap_or_else(|| req.id.clone());
            let node = graph.add_node(id.clone());
            nodes.insert(id, node);
        }

        for req in requests {
            let id = req.name.clone().unwrap_or_else(|| req.id.clone());
            let Some(&from) = nodes.get(&id) else { continue };
            for dep in &req.depends_on {
                if let DependencyRef::Local { name } = dep {
                    if let Some(&to) = nodes.get(name) {
                        graph.add_edge(to, from, ());
                    }
                }
            }
        }

        Self { graph, nodes }
    }

    /// Order target + ancestors topologically.
    pub fn resolve_execution_order(&self, target_id: &str) -> Result<Vec<String>, DependencyError> {
        let target = *self
            .nodes
            .get(target_id)
            .ok_or_else(|| DependencyError::TargetNotFound(target_id.to_string()))?;

        let mut ancestors = self.ancestors_of(target);
        ancestors.push(target);

        let mut sub: DiGraph<String, ()> = DiGraph::new();
        let mut sub_nodes: HashMap<NodeIndex, NodeIndex> = HashMap::default();
        for n in &ancestors {
            let id = self.graph[*n].clone();
            let new_n = sub.add_node(id);
            sub_nodes.insert(*n, new_n);
        }
        for n in &ancestors {
            if let Some(&new_n) = sub_nodes.get(n) {
                for nb in self
                    .graph
                    .neighbors_directed(*n, petgraph::Direction::Incoming)
                {
                    if let Some(&new_nb) = sub_nodes.get(&nb) {
                        sub.add_edge(new_nb, new_n, ());
                    }
                }
            }
        }
        let sorted = toposort(&sub, None).map_err(|_| DependencyError::CycleDetected)?;
        Ok(sorted.into_iter().map(|n| sub[n].clone()).collect())
    }

    /// Direct (1-hop) dependencies of `request_id`.
    pub fn get_direct_dependencies(&self, request_id: &str) -> Vec<String> {
        if let Some(&node) = self.nodes.get(request_id) {
            self.graph
                .neighbors_directed(node, petgraph::Direction::Incoming)
                .map(|n| self.graph[n].clone())
                .collect()
        } else {
            Vec::new()
        }
    }

    /// Cycle detection over the whole graph.
    pub fn has_cycle(&self) -> bool {
        toposort(&self.graph, None).is_err()
    }

    fn ancestors_of(&self, node: NodeIndex) -> Vec<NodeIndex> {
        let mut out = Vec::new();
        let mut visited: HashSet<NodeIndex> = HashSet::default();
        let mut stack = vec![node];
        while let Some(cur) = stack.pop() {
            for nb in self
                .graph
                .neighbors_directed(cur, petgraph::Direction::Incoming)
            {
                if visited.insert(nb) {
                    out.push(nb);
                    stack.push(nb);
                }
            }
        }
        out
    }
}

/// Convenience wrapper for the local-only resolver.
pub fn resolve_execution_order(
    requests: &[HttpRequest],
    target_id: &str,
) -> Result<Vec<String>, DependencyError> {
    DependencyResolver::new(requests).resolve_execution_order(target_id)
}

/// Cross-file dependency resolver. Borrows a [`FileRegistry`] so concurrent
/// invocations share the same parse cache.
pub struct CrossFileDependencyResolver<'a> {
    registry: &'a FileRegistry,
    graph: DiGraph<QualifiedRequestId, ()>,
    nodes: HashMap<QualifiedRequestId, NodeIndex>,
}

impl<'a> CrossFileDependencyResolver<'a> {
    /// Construct against a shared registry.
    pub fn new(registry: &'a FileRegistry) -> Self {
        Self {
            registry,
            graph: DiGraph::new(),
            nodes: HashMap::default(),
        }
    }

    /// Resolve every (local + cross-file) dependency of `target_request`
    /// and return the chain in topological order.
    #[tracing::instrument(skip_all, fields(target = ?target_request.name))]
    pub fn resolve(
        &mut self,
        target_request: &HttpRequest,
    ) -> Result<Vec<HttpRequest>, CrossFileDependencyError> {
        let target_id = self.add_request(target_request)?;
        self.resolve_recursive(&target_id)?;

        let &target_node = self
            .nodes
            .get(&target_id)
            .ok_or_else(|| CrossFileDependencyError::RequestNotFound {
                file: target_id.file_path.clone(),
                request: target_id.request_name.clone(),
            })?;

        let mut ancestors = self.ancestors_of(target_node);
        let mut sub: DiGraph<QualifiedRequestId, ()> = DiGraph::new();
        let mut sub_nodes: HashMap<NodeIndex, NodeIndex> = HashMap::default();
        ancestors.push(target_node);

        for n in &ancestors {
            let id = self.graph[*n].clone();
            let new_n = sub.add_node(id);
            sub_nodes.insert(*n, new_n);
        }
        for n in &ancestors {
            if let Some(&new_n) = sub_nodes.get(n) {
                for nb in self
                    .graph
                    .neighbors_directed(*n, petgraph::Direction::Incoming)
                {
                    if let Some(&new_nb) = sub_nodes.get(&nb) {
                        sub.add_edge(new_nb, new_n, ());
                    }
                }
            }
        }

        let sorted = toposort(&sub, None)
            .map_err(|_| CrossFileDependencyError::CycleDetected(target_id.request_name.clone()))?;

        let mut chain = Vec::with_capacity(sorted.len());
        for node in sorted {
            chain.push(self.fetch_request(&sub[node])?);
        }
        Ok(chain)
    }

    fn add_request(
        &mut self,
        request: &HttpRequest,
    ) -> Result<QualifiedRequestId, CrossFileDependencyError> {
        let qid = QualifiedRequestId::from_request(request).ok_or_else(|| {
            CrossFileDependencyError::FileNotFound("unknown source file".to_string())
        })?;
        if !self.nodes.contains_key(&qid) {
            let n = self.graph.add_node(qid.clone());
            self.nodes.insert(qid.clone(), n);
        }
        Ok(qid)
    }

    fn resolve_recursive(
        &mut self,
        request_id: &QualifiedRequestId,
    ) -> Result<(), CrossFileDependencyError> {
        let request = self.fetch_request(request_id)?;
        let &from_node = self.nodes.get(request_id).unwrap();

        for dep in &request.depends_on {
            let dep_id = self.resolve_dep_ref(request_id, dep)?;
            if !self.nodes.contains_key(&dep_id) {
                let _ = self.fetch_request(&dep_id)?; // ensure loadable
                let n = self.graph.add_node(dep_id.clone());
                self.nodes.insert(dep_id.clone(), n);
                self.resolve_recursive(&dep_id)?;
            }
            let dep_node = *self.nodes.get(&dep_id).unwrap();
            self.graph.add_edge(dep_node, from_node, ());
        }
        Ok(())
    }

    fn resolve_dep_ref(
        &self,
        from: &QualifiedRequestId,
        dep: &DependencyRef,
    ) -> Result<QualifiedRequestId, CrossFileDependencyError> {
        match dep {
            DependencyRef::Local { name } => {
                Ok(QualifiedRequestId::new(&from.file_path, name))
            }
            DependencyRef::CrossFile {
                file_path,
                request_name,
            } => {
                let base = Path::new(&from.file_path);
                let resolved = FileRegistry::resolve_path(base, file_path).map_err(|e| match e {
                    FileRegistryError::FileNotFound(_) => {
                        CrossFileDependencyError::FileNotFound(file_path.clone())
                    }
                    FileRegistryError::ReadError { path, source } => {
                        CrossFileDependencyError::FileReadError(
                            path.display().to_string(),
                            source.to_string(),
                        )
                    }
                    FileRegistryError::InvalidPath(p) => {
                        CrossFileDependencyError::FileNotFound(p)
                    }
                })?;
                self.registry.get_or_load(&resolved).map_err(|e| match e {
                    FileRegistryError::FileNotFound(p) => {
                        CrossFileDependencyError::FileNotFound(p.display().to_string())
                    }
                    FileRegistryError::ReadError { path, source } => {
                        CrossFileDependencyError::FileReadError(
                            path.display().to_string(),
                            source.to_string(),
                        )
                    }
                    FileRegistryError::InvalidPath(p) => {
                        CrossFileDependencyError::FileNotFound(p)
                    }
                })?;
                Ok(QualifiedRequestId::new(
                    resolved.display().to_string(),
                    request_name,
                ))
            }
        }
    }

    fn fetch_request(
        &self,
        qid: &QualifiedRequestId,
    ) -> Result<HttpRequest, CrossFileDependencyError> {
        let path = Path::new(&qid.file_path);
        let file = self
            .registry
            .get_or_load(path)
            .map_err(|_| CrossFileDependencyError::FileNotFound(qid.file_path.clone()))?;
        file.requests
            .iter()
            .find(|r| r.name.as_deref() == Some(&qid.request_name) || r.id == qid.request_name)
            .cloned()
            .ok_or_else(|| CrossFileDependencyError::RequestNotFound {
                file: qid.file_path.clone(),
                request: qid.request_name.clone(),
            })
    }

    fn ancestors_of(&self, node: NodeIndex) -> Vec<NodeIndex> {
        let mut out = Vec::new();
        let mut visited: HashSet<NodeIndex> = HashSet::default();
        let mut stack = vec![node];
        while let Some(cur) = stack.pop() {
            for nb in self
                .graph
                .neighbors_directed(cur, petgraph::Direction::Incoming)
            {
                if visited.insert(nb) {
                    out.push(nb);
                    stack.push(nb);
                }
            }
        }
        out
    }
}

/// Helper: does `request` reference any cross-file dependency?
pub fn has_cross_file_dependencies(request: &HttpRequest) -> bool {
    request.depends_on.iter().any(DependencyRef::is_cross_file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zen_types::request::HttpMethod;

    fn make(name: &str, deps: &[&str]) -> HttpRequest {
        HttpRequest {
            id: uuid::Uuid::new_v4().to_string(),
            name: Some(name.to_string()),
            method: HttpMethod::Get,
            url: format!("http://x/{name}"),
            depends_on: deps
                .iter()
                .map(|d| DependencyRef::Local {
                    name: (*d).to_string(),
                })
                .collect(),
            ..HttpRequest::default()
        }
    }

    #[test]
    fn simple_chain_orders_correctly() {
        let reqs = vec![make("Login", &[]), make("GetProfile", &["Login"])];
        assert_eq!(
            resolve_execution_order(&reqs, "GetProfile").unwrap(),
            vec!["Login", "GetProfile"]
        );
    }

    #[test]
    fn three_level_chain() {
        let reqs = vec![make("A", &[]), make("B", &["A"]), make("C", &["B"])];
        assert_eq!(
            resolve_execution_order(&reqs, "C").unwrap(),
            vec!["A", "B", "C"]
        );
    }

    #[test]
    fn cycle_detected() {
        let reqs = vec![make("A", &["B"]), make("B", &["A"])];
        assert!(matches!(
            resolve_execution_order(&reqs, "A"),
            Err(DependencyError::CycleDetected)
        ));
    }
}
