/**
 * SQL editor — wraps the shared `CodeEditor` with `@codemirror/lang-sql`
 * and the appropriate dialect (Postgres vs T-SQL).
 */

import { useMemo, type Ref } from "react";
import type { Extension } from "@codemirror/state";
import { sql, PostgreSQL, MSSQL } from "@codemirror/lang-sql";
import {
  CodeEditor,
  type CodeEditorHandle,
} from "@/components/code-editor";
import type { DbDriverId } from "../lib/tauri";

export type SqlEditorHandle = CodeEditorHandle;

export interface SqlEditorProps {
  value: string;
  driver: DbDriverId;
  onChange?: (value: string) => void;
  onSave?: (value: string) => void;
  /** Run handler — fired on Mod-Enter. */
  onRun?: () => void;
  vimMode?: boolean;
  imperativeRef?: Ref<SqlEditorHandle>;
}

export function SqlEditor({
  value,
  driver,
  onChange,
  onSave,
  onRun,
  vimMode = true,
  imperativeRef,
}: SqlEditorProps) {
  const buildExtensions = useMemo(
    () =>
      (_env: { isDark: boolean }): Extension[] => [
        sql({
          dialect: driver === "postgres" ? PostgreSQL : MSSQL,
          upperCaseKeywords: true,
        }),
      ],
    [driver],
  );

  return (
    <CodeEditor
      value={value}
      onChange={onChange}
      onSave={onSave}
      onRunLine={onRun ? () => onRun() : undefined}
      vimMode={vimMode}
      imperativeRef={imperativeRef}
      extensions={buildExtensions}
    />
  );
}
