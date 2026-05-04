## Default Permission

Default permissions for the ghostty terminal plugin.

#### This default permission set includes the following:

- `allow-terminal-new`
- `allow-terminal-set-color-scheme`
- `allow-terminal-split`
- `allow-terminal-focus-split`
- `allow-terminal-new-tab`
- `allow-terminal-focus-tab`
- `allow-terminal-close-tab`
- `allow-terminal-list-tabs`
- `allow-terminal-set-chrome-inset`
- `allow-terminal-set-close-window-on-last-tab`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`ghostty:allow-terminal-focus-split`

</td>
<td>

Enables the terminal_focus_split command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`ghostty:deny-terminal-focus-split`

</td>
<td>

Denies the terminal_focus_split command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`ghostty:allow-terminal-new`

</td>
<td>

Enables the terminal_new command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`ghostty:deny-terminal-new`

</td>
<td>

Denies the terminal_new command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`ghostty:allow-terminal-set-color-scheme`

</td>
<td>

Enables the terminal_set_color_scheme command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`ghostty:deny-terminal-set-color-scheme`

</td>
<td>

Denies the terminal_set_color_scheme command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`ghostty:allow-terminal-split`

</td>
<td>

Enables the terminal_split command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`ghostty:deny-terminal-split`

</td>
<td>

Denies the terminal_split command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`ghostty:allow-terminal-new`

</td>
<td>

Allows creating a new terminal surface attached to a window.

</td>
</tr>

<tr>
<td>

`ghostty:allow-terminal-set-color-scheme`

</td>
<td>

Allows setting the dark/light color scheme on the ghostty app.

</td>
</tr>

<tr>
<td>

`ghostty:allow-terminal-split`

</td>
<td>

Allows splitting an existing terminal surface.

</td>
</tr>

<tr>
<td>

`ghostty:allow-terminal-focus-split`

</td>
<td>

Allows moving keyboard focus between split panes.

</td>
</tr>

<tr>
<td>

`ghostty:allow-terminal-new-tab`

</td>
<td>

Allows creating a new tab (a fresh GhosttyHostView + surface mounted in the tab container).

</td>
</tr>

<tr>
<td>

`ghostty:allow-terminal-focus-tab`

</td>
<td>

Allows switching the active tab by id.

</td>
</tr>

<tr>
<td>

`ghostty:allow-terminal-close-tab`

</td>
<td>

Allows closing a tab by id (frees the surfaces under that tab).

</td>
</tr>

<tr>
<td>

`ghostty:allow-terminal-list-tabs`

</td>
<td>

Allows enumerating currently mounted tabs.

</td>
</tr>

<tr>
<td>

`ghostty:allow-terminal-set-chrome-inset`

</td>
<td>

Allows the HTML side to push its measured chrome insets so the native tab content area is sized correctly.

</td>
</tr>

<tr>
<td>

`ghostty:allow-terminal-set-close-window-on-last-tab`

</td>
<td>

Toggles the policy of whether closing the last tab also closes the window. Default true; embedders override.

</td>
</tr>
</table>
