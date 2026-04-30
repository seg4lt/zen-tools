//! Tree data model used by the UI.
//!
//! Sections (`Repositories`, `Global Dev Files`) hold leaf nodes for each
//! discovered repo / cache target. Each leaf can be marked with an
//! [`NodeAction`] and the running totals update in-place as the
//! background size estimator reports back.

use std::path::{Path, PathBuf};

/// What a node represents in the tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeKind {
    /// Top-level grouping header (Repositories / Global Dev Files).
    Section,
    /// A discovered git repository root.
    Repo,
    /// A global dev-tool cache directory.
    GlobalPath,
}

/// User-selected action to apply when the run is committed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeAction {
    /// Skip this node.
    None,
    /// `git clean -fxd` (repo nodes only).
    Clean,
    /// `rm -rf` (repos and global paths).
    Delete,
}

impl NodeAction {
    /// Cycle `None → Clean → Delete → None`.
    pub fn cycle(self) -> Self {
        match self {
            Self::None => Self::Clean,
            Self::Clean => Self::Delete,
            Self::Delete => Self::None,
        }
    }
}

/// Per-repo tracking of which size estimates have settled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RepoEstimateStatus {
    /// `clean_size` has finished computing (the value may still be `None`).
    pub clean_done: bool,
    /// `delete_size` has finished computing.
    pub delete_done: bool,
}

/// One node in the cleanup tree.
///
/// Section nodes carry no path; leaf nodes carry an absolute path and the
/// optional size estimate fields populated asynchronously.
#[derive(Debug, Clone)]
pub struct TreeNode {
    /// Stable id (e.g. `repos//abs/path` or `globals//abs/path`).
    pub id: String,
    /// Display label (basename for repos, descriptive label for globals).
    pub label: String,
    /// Node kind discriminator.
    pub kind: NodeKind,
    /// Whether this node represents a directory.
    pub is_dir: bool,
    /// Whether this node's children are visible.
    pub is_expanded: bool,
    /// Currently-marked action.
    pub action: NodeAction,
    /// Display indentation level.
    pub depth: usize,
    /// Children nodes (only sections currently have children).
    pub children: Vec<TreeNode>,
    /// Backing path on disk.
    pub path: PathBuf,
    /// Total size in bytes (global paths only).
    pub size: Option<u64>,
    /// `true` once the size estimator has finished — `size` may still be `None`.
    pub size_done: bool,
    /// Repo only: bytes that `git clean -fxd` would reclaim.
    pub clean_size: Option<u64>,
    /// Repo only: total repo size on disk.
    pub delete_size: Option<u64>,
    /// Repo only: tracks completion of the two estimates above.
    pub repo_estimate_status: Option<RepoEstimateStatus>,
}

impl TreeNode {
    /// Construct a default-expanded, action-cleared node.
    pub fn new(
        id: String,
        label: String,
        kind: NodeKind,
        is_dir: bool,
        depth: usize,
        path: PathBuf,
    ) -> Self {
        Self {
            id,
            label,
            kind,
            is_dir,
            is_expanded: true,
            action: NodeAction::None,
            depth,
            children: Vec::new(),
            path,
            size: None,
            size_done: false,
            clean_size: None,
            delete_size: None,
            repo_estimate_status: None,
        }
    }

    /// Cycle the action — repos go through all three states, globals only
    /// toggle `None` ↔ `Delete` (clean is meaningless outside a repo).
    pub fn cycle_action(&mut self) {
        match self.kind {
            NodeKind::Section => {}
            NodeKind::Repo => {
                self.action = self.action.cycle();
            }
            NodeKind::GlobalPath => {
                self.action = match self.action {
                    NodeAction::None => NodeAction::Delete,
                    NodeAction::Delete => NodeAction::None,
                    NodeAction::Clean => NodeAction::Delete,
                };
            }
        }
    }

    /// Section headers are not selectable.
    pub fn can_be_marked(&self) -> bool {
        self.kind != NodeKind::Section
    }
}

/// Discovered global cache entry, fed into [`Tree::build`].
#[derive(Debug, Clone)]
pub struct GlobalTreeEntry {
    /// Display label.
    pub label: String,
    /// Path on disk.
    pub path: PathBuf,
    /// Whether the path is a directory.
    pub is_dir: bool,
    /// Pre-computed size, if already known.
    pub size: Option<u64>,
}

/// Top-level tree the UI binds to.
#[derive(Debug, Clone, Default)]
pub struct Tree {
    /// Section roots in display order.
    pub roots: Vec<TreeNode>,
}

impl Tree {
    /// Empty tree.
    pub fn new() -> Self {
        Self { roots: Vec::new() }
    }

    /// Build a fresh tree from `repo_paths` (under one folder) and the
    /// global entries.  Either or both may be empty — empty sections are
    /// omitted entirely.
    pub fn build(repo_paths: Vec<PathBuf>, global_entries: Vec<GlobalTreeEntry>) -> Self {
        let mut tree = Self::new();
        if !repo_paths.is_empty() {
            let mut repo_section = TreeNode::new(
                "repos".to_string(),
                "Repositories".to_string(),
                NodeKind::Section,
                true,
                0,
                PathBuf::new(),
            );

            for repo_path in repo_paths {
                let repo_name = repo_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("unknown")
                    .to_string();
                let id = format!("repos/{}", repo_path.to_string_lossy());
                repo_section.children.push(TreeNode::new(
                    id,
                    repo_name,
                    NodeKind::Repo,
                    true,
                    1,
                    repo_path,
                ));
                if let Some(repo_node) = repo_section.children.last_mut() {
                    repo_node.repo_estimate_status = Some(RepoEstimateStatus::default());
                }
            }

            tree.roots.push(repo_section);
        }

        if !global_entries.is_empty() {
            let mut global_section = TreeNode::new(
                "globals".to_string(),
                "Global Dev Files".to_string(),
                NodeKind::Section,
                true,
                0,
                PathBuf::new(),
            );

            for entry in global_entries {
                let id = format!("globals/{}", entry.path.to_string_lossy());
                let mut node = TreeNode::new(
                    id,
                    entry.label,
                    NodeKind::GlobalPath,
                    entry.is_dir,
                    1,
                    entry.path,
                );
                node.size = entry.size;
                node.size_done = entry.size.is_some();
                global_section.children.push(node);
            }

            tree.roots.push(global_section);
        }
        tree
    }

    /// Mutably resolve a node by id.
    pub fn get_node_mut_by_id(&mut self, id: &str) -> Option<&mut TreeNode> {
        for root in &mut self.roots {
            if let Some(node) = find_node_mut(root, id) {
                return Some(node);
            }
        }
        None
    }

    /// All currently-marked leaf nodes (section headers excluded).
    pub fn get_marked_nodes(&self) -> Vec<&TreeNode> {
        let mut marked = Vec::new();
        for root in &self.roots {
            collect_marked(root, &mut marked);
        }
        marked
    }

    /// Repo lookup by absolute path.
    pub fn get_repo_node_mut_by_path(&mut self, repo_path: &Path) -> Option<&mut TreeNode> {
        self.roots
            .iter_mut()
            .flat_map(|root| root.children.iter_mut())
            .find(|node| node.kind == NodeKind::Repo && node.path == repo_path)
    }

    /// Global-target lookup by absolute path.
    pub fn get_global_node_mut_by_path(&mut self, target_path: &Path) -> Option<&mut TreeNode> {
        self.roots
            .iter_mut()
            .flat_map(|root| root.children.iter_mut())
            .find(|node| node.kind == NodeKind::GlobalPath && node.path == target_path)
    }

    /// Apply a finished repo estimate to its node. Returns `false` if the
    /// node could not be found (the user removed the folder mid-scan).
    pub fn update_repo_estimate(
        &mut self,
        repo_path: &Path,
        clean_size: Option<u64>,
        delete_size: Option<u64>,
    ) -> bool {
        let Some(node) = self.get_repo_node_mut_by_path(repo_path) else {
            return false;
        };

        node.clean_size = clean_size;
        node.delete_size = delete_size;
        let mut status = node.repo_estimate_status.unwrap_or_default();
        status.clean_done = true;
        status.delete_done = true;
        node.repo_estimate_status = Some(status);
        true
    }

    /// Apply a finished global-path size to its node.
    pub fn update_global_size(&mut self, target_path: &Path, size: Option<u64>) -> bool {
        let Some(node) = self.get_global_node_mut_by_path(target_path) else {
            return false;
        };

        node.size = size;
        node.size_done = true;
        true
    }
}

fn find_node_mut<'a>(node: &'a mut TreeNode, id: &str) -> Option<&'a mut TreeNode> {
    if node.id == id {
        return Some(node);
    }

    for child in &mut node.children {
        if let Some(found) = find_node_mut(child, id) {
            return Some(found);
        }
    }

    None
}

fn collect_marked<'a>(node: &'a TreeNode, marked: &mut Vec<&'a TreeNode>) {
    if node.can_be_marked() && node.action != NodeAction::None {
        marked.push(node);
    }

    for child in &node.children {
        collect_marked(child, marked);
    }
}

/// `1.4 G`-style human-readable byte size.
pub fn format_size(bytes: u64) -> String {
    const UNITS: &[&str] = &["B", "K", "M", "G", "T"];
    let mut size = bytes as f64;
    let mut unit_index = 0;

    while size >= 1024.0 && unit_index < UNITS.len() - 1 {
        size /= 1024.0;
        unit_index += 1;
    }

    if unit_index == 0 {
        format!("{} {}", bytes, UNITS[unit_index])
    } else {
        format!("{:.1} {}", size, UNITS[unit_index])
    }
}
