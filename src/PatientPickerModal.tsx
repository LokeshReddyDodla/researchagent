import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, listPatients, PatientListItem } from "./api";

interface Props {
  token: string;
  /** Patient IDs already selected before the modal opened. */
  initialSelectedIds: string[];
  /** Patient display info for ids the user already selected previously
   *  but that aren't in the current page (preserves chip labels). */
  initialKnownPatients?: PatientListItem[];
  onClose: () => void;
  /** Called when the user confirms. Receives the final selection. */
  onConfirm: (selected: PatientListItem[]) => void;
}

// One page is enough for almost every provider. Care provider panels
// in this codebase are typically small to mid-sized; if a provider has
// >500 we'll bump this or paginate properly.
const PAGE_SIZE = 500;

export default function PatientPickerModal({
  token,
  initialSelectedIds,
  initialKnownPatients = [],
  onClose,
  onConfirm,
}: Props) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [items, setItems] = useState<PatientListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Selection lives as a Set for O(1) toggle. Initial value = ids passed in.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialSelectedIds),
  );

  // Cache patient display info across paginations so we can build
  // proper chips on confirm even for selections from previous searches.
  const knownById = useRef<Map<string, PatientListItem>>(
    new Map(
      initialKnownPatients.map((p) => [p.patient_id, p] as [string, PatientListItem]),
    ),
  );

  const searchRef = useRef<HTMLInputElement>(null);

  // Auto-focus search on mount.
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Debounce the search box so we don't hammer the API on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Fetch the patient list whenever the debounced search changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listPatients(token, { limit: PAGE_SIZE, search: debouncedSearch || undefined })
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setTotal(res.total);
        // Cache for chip-label lookup later.
        for (const item of res.items) {
          knownById.current.set(item.patient_id, item);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        const err = e as ApiError;
        setError(err.message ?? "Failed to load patients.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, debouncedSearch]);

  // Escape closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const visibleIds = useMemo(() => items.map((i) => i.patient_id), [items]);

  const visibleSelectedCount = useMemo(
    () => visibleIds.filter((id) => selected.has(id)).length,
    [visibleIds, selected],
  );

  const allVisibleSelected =
    visibleIds.length > 0 && visibleSelectedCount === visibleIds.length;
  const someVisibleSelected =
    visibleSelectedCount > 0 && !allVisibleSelected;

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  }

  function clearAll() {
    setSelected(new Set());
  }

  function handleConfirm() {
    // Build the final list with display info for chips. For selected ids
    // that aren't in our cache (shouldn't happen in normal use, but safe),
    // synthesize a placeholder so the cohort.ids payload is still correct.
    const final: PatientListItem[] = [];
    for (const id of selected) {
      const cached = knownById.current.get(id);
      final.push(
        cached ?? {
          patient_id: id,
          first_name: null,
          last_name: null,
          last_active_at: null,
        },
      );
    }
    onConfirm(final);
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose} role="dialog" aria-modal="true">
      <div
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        role="document"
      >
        <header className="modal-head">
          <h2>Choose patients</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="modal-search">
          <input
            ref={searchRef}
            type="text"
            placeholder="Search by name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="modal-bar">
          <label className="checkrow-allvis">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              ref={(el) => {
                if (el) el.indeterminate = someVisibleSelected;
              }}
              onChange={toggleAllVisible}
              disabled={visibleIds.length === 0}
            />
            <span>
              {allVisibleSelected
                ? "Deselect all visible"
                : someVisibleSelected
                  ? "Select remaining"
                  : "Select all visible"}
            </span>
          </label>
          <div className="modal-bar-meta">
            {loading
              ? "loading…"
              : `${items.length} shown · ${total} total`}
          </div>
        </div>

        <div className="modal-list">
          {error ? (
            <div className="modal-error">{error}</div>
          ) : items.length === 0 && !loading ? (
            <div className="modal-empty">
              {debouncedSearch
                ? `No patients match “${debouncedSearch}”.`
                : "No patients assigned to you yet."}
            </div>
          ) : (
            items.map((p, idx) => {
              const isSelected = selected.has(p.patient_id);
              const fullName = joinName(p.first_name, p.last_name);
              const name =
                fullName ||
                (p.patient_id
                  ? `Patient #${p.patient_id.slice(0, 8)}`
                  : "Unknown patient");
              const hasRealName = Boolean(fullName);
              return (
                <label
                  key={p.patient_id || `row-${idx}`}
                  className={`patient-row ${isSelected ? "selected" : ""} ${hasRealName ? "" : "patient-row-noname"}`}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleOne(p.patient_id)}
                  />
                  <div className="patient-row-text">
                    <div className="patient-name">{name}</div>
                    <div className="patient-sub">
                      id {shortId(p.patient_id)}
                      {p.last_active_at ? ` · last active ${formatRel(p.last_active_at)}` : ""}
                    </div>
                  </div>
                </label>
              );
            })
          )}
        </div>

        <footer className="modal-foot">
          <div className="modal-foot-meta">
            <strong>{selected.size}</strong> selected
            {selected.size > 0 && (
              <button
                type="button"
                className="linklike"
                onClick={clearAll}
                style={{ marginLeft: 10 }}
              >
                Clear
              </button>
            )}
          </div>
          <div className="modal-foot-actions">
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="button" onClick={handleConfirm} disabled={selected.size === 0}>
              Use {selected.size} patient{selected.size === 1 ? "" : "s"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function joinName(first: string | null, last: string | null): string {
  return [first, last].filter(Boolean).join(" ").trim();
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function formatRel(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const sec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86_400)}d ago`;
}
