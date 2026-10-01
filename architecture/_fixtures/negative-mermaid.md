# negative fixture
```mermaid
flowchart TD
    A["start"] --> B{branch}
    B -- yes --> UNDECLARED_TARGET
    C[x"] --> D["ok"]
```
```mermaid
sequenceDiagram
    participant CLI
    CLI->>GHOST: hello
    alt conflict
    CLI->>CLI: thing
```
```mermaid
flowchart LR
    subgraph one
    X["a"] --> Y["b"]
```
