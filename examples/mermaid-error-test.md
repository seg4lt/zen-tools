# Mermaid Error Test

## Valid diagram (should render fine)

```mermaid
flowchart LR
    A[Start] --> B{Decision}
    B -->|Yes| C[Do it]
    B -->|No| D[Skip it]
    C --> E[End]
    D --> E
```

## Bad syntax (should show compact error badge)

```mermaid
flowchart LR
    A[Start --> B{Missing bracket
    B -->|Yes C[Oops
    ??? invalid tokens here @@
```

## Another valid diagram (should render fine — layout stays stable)

```mermaid
sequenceDiagram
    Alice->>Bob: Hello Bob!
    Bob-->>Alice: Hi Alice!
```
