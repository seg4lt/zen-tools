/**
 * Custom CodeMirror 6 gutter that places a "run" icon next to lines that
 * begin a request (the `METHOD URL` line in IntelliJ-style `.http`
 * files). Clicking the icon dispatches an event handler with the line
 * number; consumers map it to an `HttpRequest`.
 */

import {
  type Extension,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  type EditorView,
  GutterMarker,
  ViewPlugin,
  type ViewUpdate,
  gutter,
} from "@codemirror/view";

const REQUEST_LINE_RE = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/;

/** Effect for storing the freshest run-line set in the editor state. */
const setRunLines = StateEffect.define<RangeSet<RunMarker>>();

/** Holds the current set of run markers. */
const runLineField = StateField.define<RangeSet<RunMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setRunLines)) next = e.value;
    }
    return next;
  },
});

class RunMarker extends GutterMarker {
  override eq(other: GutterMarker): boolean {
    return other instanceof RunMarker;
  }
  override toDOM(): HTMLElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-run-marker";
    btn.title = "Run request (Cmd+Enter)";
    btn.setAttribute("aria-label", "Run request");
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    return btn;
  }
}

/**
 * Build a fresh range set of run markers by scanning every line in the
 * doc that starts with an HTTP method.
 */
function computeRunLines(view: EditorView): RangeSet<RunMarker> {
  const builder = new RangeSetBuilder<RunMarker>();
  const total = view.state.doc.lines;
  for (let i = 1; i <= total; i++) {
    const line = view.state.doc.line(i);
    if (REQUEST_LINE_RE.test(line.text.trimStart())) {
      builder.add(line.from, line.from, new RunMarker());
    }
  }
  return builder.finish();
}

/**
 * Build the run-gutter extension.
 *
 * @param onRunLine called with the 1-based line number of the clicked icon.
 */
export function runGutter(onRunLine: (line: number) => void): Extension {
  const updater = ViewPlugin.fromClass(
    class {
      constructor(view: EditorView) {
        view.dispatch({ effects: setRunLines.of(computeRunLines(view)) });
      }
      update(update: ViewUpdate) {
        if (update.docChanged) {
          update.view.dispatch({
            effects: setRunLines.of(computeRunLines(update.view)),
          });
        }
      }
    },
  );

  return [
    runLineField,
    updater,
    gutter({
      class: "cm-run-gutter",
      markers: (view) => view.state.field(runLineField),
      domEventHandlers: {
        click(view, line, event) {
          const target = event.target as HTMLElement | null;
          if (!target?.closest(".cm-run-marker")) return false;
          const lineNum = view.state.doc.lineAt(line.from).number;
          onRunLine(lineNum);
          return true;
        },
      },
    }),
  ];
}
