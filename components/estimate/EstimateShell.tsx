/**
 * File: components/estimate/EstimateShell.tsx
 * THE shared SHAPE of a line-item form: section headings, Add-line controls, the row card layout,
 * and the catalogue-code autocomplete. Presentation only.
 *
 * WHY PRESENTATION ONLY, AND NOT A SHARED ROW. Two surfaces use this shape and they genuinely
 * disagree about what a line IS:
 *   quoting  — COMPOSES a price: unit × qty, and the line total is derived.
 *   importing — DECOMPOSES a fixed printed total: the amount is typed and the unit price derived,
 *               because a parent of 2 × £133.3333 = £266.67 has no typable unit price.
 * A row with `amountFirst` / `costEditable` switches would encode both behaviours in one place and
 * leave the quote page ONE PROP away from client-writable unit_cost — which is forbidden
 * (ruling 2026-07-12, re-affirmed 2026-07-17; pages/api/jobcard-quote.ts discards client cost
 * server-side). So this file owns the LAYOUT and each surface owns its own FIELDS, passed in as
 * children. Nothing here reads or writes a cost, a price or a total.
 */
import React from 'react';

export const inputCls = 'w-full p-2 bg-surface border border-line rounded-lg text-ink text-sm focus:ring-accent focus:border-accent';
export const labelCls = 'block text-xs text-muted mb-1';

/** The datalist id both surfaces point their code inputs at. */
export const CODES_DATALIST = 'gd-catalogue-codes';

/** Catalogue codes for autocomplete. Rendered once per form. */
export function CodesDatalist({ codes }: { codes: Array<{ id: string; code: string; name: string }> }) {
  return (
    <datalist id={CODES_DATALIST}>
      {codes.map((c) => <option key={c.id} value={c.code}>{c.name}</option>)}
    </datalist>
  );
}

/** The code box, in the column position both surfaces use. */
export function CodeField({ label, placeholder, value, disabled, onChange }: {
  label: string; placeholder?: string; value: string; disabled?: boolean; onChange: (v: string) => void;
}) {
  return (
    <div className="sm:w-28">
      <label className={labelCls}>{label}</label>
      <input className={inputCls} placeholder={placeholder} value={value} list={CODES_DATALIST}
        autoCapitalize="characters" autoCorrect="off" spellCheck={false}
        disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/**
 * ONE line's card. Mobile-first: a stacked touch card on a phone, an aligned row at sm+ — the
 * layout the quote page has always used, now expressed once.
 *
 * `code`, `fields` and `trailing` are SLOTS. The caller decides what a field is; this decides where
 * it sits. `description` is the one field both surfaces agree on, so it is rendered here.
 */
export function LineCard({ code, description, fields, trailing, onRemove, removeLabel, canEdit = true }: {
  code?: React.ReactNode;
  description: React.ReactNode;
  fields?: React.ReactNode;
  trailing?: React.ReactNode;
  onRemove?: () => void;
  removeLabel?: string;
  canEdit?: boolean;
}) {
  return (
    <div className="bg-surface-muted border border-line rounded-lg p-3 mb-2 flex flex-col sm:flex-row sm:items-end gap-2">
      {code}
      <div className="sm:flex-1">{description}</div>
      {fields}
      {trailing}
      {canEdit && onRemove && (
        <button onClick={onRemove} aria-label={removeLabel}
          className="text-danger hover:text-danger text-sm px-2 py-2 self-end">✕</button>
      )}
    </div>
  );
}

/** A titled group of lines with its empty state and its Add control. */
export function LineSection({ title, empty, isEmpty, addLabel, onAdd, hint, children, className = 'mt-2' }: {
  title: string;
  empty?: string;
  isEmpty?: boolean;
  addLabel?: string;
  onAdd?: () => void;
  hint?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <>
      <h3 className={`text-sm font-semibold text-ink ${className} mb-2`}>{title}</h3>
      {isEmpty && empty && <p className="text-muted text-sm mb-2">{empty}</p>}
      {children}
      {onAdd && addLabel && (
        <div className="mb-4">
          <button onClick={onAdd} className="text-xs text-accent hover:underline">+ {addLabel}</button>
          {hint && <p className="text-xs text-muted mt-1">{hint}</p>}
        </div>
      )}
    </>
  );
}
