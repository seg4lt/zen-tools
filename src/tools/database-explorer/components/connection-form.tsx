/**
 * Add / edit a database connection. The form is shown as a Radix dialog.
 * Save persists metadata to `preferences.json` and the password to the
 * OS keychain via `db_save_connection`.
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@zen-tools/ui";
import { Button } from "@zen-tools/ui";
import {
  dbTauri,
  type DbConnectionInput,
  type DbConnectionPrefs,
  type DbDriverId,
} from "../lib/tauri";
import { formatError } from "../lib/format-error";
import { useDbExplorerStore } from "../store/db-explorer-store";

interface DriverDefaults {
  port: number;
  database: string;
  username: string;
  trustServerCertificate?: boolean;
}

const DEFAULTS: Record<DbDriverId, DriverDefaults> = {
  postgres: { port: 5432, database: "zen_dev", username: "zen" },
  mssql: {
    port: 1433,
    database: "master",
    username: "sa",
    trustServerCertificate: true,
  },
};

function makeId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

function emptyForm(driver: DbDriverId): DbConnectionInput {
  const d = DEFAULTS[driver];
  return {
    id: makeId(),
    name: driver === "postgres" ? "Local Postgres" : "Local MSSQL",
    driver,
    host: "localhost",
    port: d.port,
    database: d.database,
    username: d.username,
    password: "",
    trustServerCertificate: d.trustServerCertificate ?? false,
  };
}

function fromPrefs(p: DbConnectionPrefs): DbConnectionInput {
  return { ...p, password: "" };
}

export function ConnectionForm() {
  const { state, dispatch } = useDbExplorerStore();
  const isOpen = state.formOpen !== false;
  const editId =
    typeof state.formOpen === "object" && state.formOpen !== null
      ? state.formOpen.editId
      : null;

  const editing = useMemo(
    () => state.connections.find((c) => c.id === editId) ?? null,
    [state.connections, editId],
  );

  const [form, setForm] = useState<DbConnectionInput>(() => emptyForm("postgres"));
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [feedback, setFeedback] = useState<
    | { kind: "ok"; message: string }
    | { kind: "err"; message: string }
    | null
  >(null);

  // Reset the form whenever the dialog opens.
  useEffect(() => {
    if (!isOpen) return;
    setFeedback(null);
    setConfirmingDelete(false);
    if (editing) {
      setForm(fromPrefs(editing));
    } else {
      setForm(emptyForm("postgres"));
    }
  }, [isOpen, editing]);

  function update<K extends keyof DbConnectionInput>(
    key: K,
    value: DbConnectionInput[K],
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function switchDriver(driver: DbDriverId) {
    setForm((prev) => {
      const d = DEFAULTS[driver];
      return {
        ...prev,
        driver,
        port: prev.port === DEFAULTS[prev.driver].port ? d.port : prev.port,
        database:
          prev.database === DEFAULTS[prev.driver].database
            ? d.database
            : prev.database,
        username:
          prev.username === DEFAULTS[prev.driver].username
            ? d.username
            : prev.username,
        trustServerCertificate: d.trustServerCertificate ?? false,
      };
    });
  }

  async function handleTest() {
    setTesting(true);
    setFeedback(null);
    try {
      await dbTauri.testConnection(form);
      setFeedback({ kind: "ok", message: "Connection OK" });
    } catch (err) {
      setFeedback({ kind: "err", message: formatError(err) });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setFeedback(null);
    try {
      await dbTauri.saveConnection(form);
      const rows = await dbTauri.listSavedConnections();
      dispatch({ type: "set-connections", connections: rows });
      dispatch({ type: "close-form" });
    } catch (err) {
      setFeedback({ kind: "err", message: formatError(err) });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!editing) return;
    setDeleting(true);
    setFeedback(null);
    try {
      await dbTauri.deleteConnection(editing.id);
      const rows = await dbTauri.listSavedConnections();
      dispatch({ type: "set-connections", connections: rows });
      if (state.activeConnectionId === editing.id) {
        dispatch({ type: "set-active-connection", id: null });
      }
      dispatch({ type: "close-form" });
    } catch (err) {
      setFeedback({ kind: "err", message: formatError(err) });
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  }

  function handleOpenChange(open: boolean) {
    if (!open) dispatch({ type: "close-form" });
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit connection" : "New connection"}</DialogTitle>
          <DialogDescription>
            Passwords are stored in the OS keychain, not in preferences.json.
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            handleSave();
          }}
        >
          {/* Driver pill toggle */}
          <div className="flex gap-2">
            <DriverButton
              active={form.driver === "postgres"}
              label="Postgres"
              onClick={() => switchDriver("postgres")}
            />
            <DriverButton
              active={form.driver === "mssql"}
              label="MSSQL"
              onClick={() => switchDriver("mssql")}
            />
          </div>

          <Field label="Name">
            <input
              autoFocus
              type="text"
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              className={inputCls}
            />
          </Field>

          <div className="grid grid-cols-3 gap-2">
            <Field label="Host" className="col-span-2">
              <input
                type="text"
                value={form.host}
                onChange={(e) => update("host", e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label="Port">
              <input
                type="number"
                value={form.port}
                onChange={(e) =>
                  update("port", Number.parseInt(e.target.value, 10) || 0)
                }
                className={inputCls}
              />
            </Field>
          </div>

          <Field label="Database">
            <input
              type="text"
              value={form.database}
              onChange={(e) => update("database", e.target.value)}
              className={inputCls}
            />
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label="Username">
              <input
                type="text"
                value={form.username}
                onChange={(e) => update("username", e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label="Password">
              <input
                type="password"
                value={form.password}
                onChange={(e) => update("password", e.target.value)}
                placeholder={editing ? "(unchanged if blank)" : ""}
                className={inputCls}
              />
            </Field>
          </div>

          {form.driver === "mssql" && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={!!form.trustServerCertificate}
                onChange={(e) =>
                  update("trustServerCertificate", e.target.checked)
                }
              />
              Trust server certificate (needed for the bundled mssql/sql-edge image)
            </label>
          )}

          {feedback && (
            <div
              className={
                "rounded border px-2 py-1 text-xs " +
                (feedback.kind === "ok"
                  ? "border-green-500/40 text-green-600"
                  : "border-red-500/40 text-red-600")
              }
            >
              {feedback.message}
            </div>
          )}

          <DialogFooter className="gap-2 sm:justify-between">
            {/* Delete only renders in edit mode; first click flips into
                a confirm state ("Click again to delete") so a misclick
                doesn't nuke the connection. */}
            {editing ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  if (confirmingDelete) {
                    void handleDelete();
                  } else {
                    setConfirmingDelete(true);
                  }
                }}
                disabled={testing || saving || deleting}
                className={
                  confirmingDelete
                    ? "text-destructive focus:text-destructive"
                    : "text-muted-foreground hover:text-destructive"
                }
                title={
                  confirmingDelete
                    ? "Click again to delete"
                    : "Delete connection"
                }
              >
                {deleting && (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                )}
                <Trash2 className="mr-1 h-3.5 w-3.5" />
                {confirmingDelete ? "Click again to delete" : "Delete"}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={handleTest}
                disabled={testing || saving || deleting}
              >
                {testing && (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                )}
                Test
              </Button>
              <Button
                type="submit"
                variant="outline"
                disabled={testing || saving || deleting}
              >
                {saving && (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                )}
                {editing ? "Save" : "Add"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const inputCls =
  "w-full rounded border border-border/60 bg-background px-2 py-1 text-sm outline-none focus:border-foreground/30";

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={"flex flex-col gap-1 " + (className ?? "")}>
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

function DriverButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "flex-1 rounded border px-3 py-1.5 text-sm transition " +
        (active
          ? "border-border bg-muted text-foreground"
          : "border-border/60 text-muted-foreground hover:bg-muted/50")
      }
    >
      {label}
    </button>
  );
}
