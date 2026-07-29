/**
 * File: components/TimezoneField.tsx
 * THE timezone control — one option renders as set (read-only, same treatment as currency);
 * several render as a select. Options and labels come from lib/timezone-choices (profile-driven,
 * state-narrowed); this component is deliberately dumb so onboarding (dark) and Settings (light)
 * can pass their own classes.
 */
import type { ZoneOption } from '@/lib/timezone-choices';

type Props = {
  id?: string;
  name?: string;
  value: string;
  options: ZoneOption[];
  fixed: boolean;
  note?: string | null;
  onChange: (zone: string) => void;
  inputClass: string;
  noteClass?: string;
};

export default function TimezoneField({ id = 'timezone', name = 'timezone', value, options, fixed, note, onChange, inputClass, noteClass }: Props) {
  if (fixed) {
    const label = options.find((o) => o.value === value)?.label ?? value;
    return (
      <>
        <input id={id} value={label} className={`${inputClass} opacity-70 cursor-not-allowed`} disabled readOnly />
        {note && <p className={noteClass ?? 'text-xs text-muted mt-1'}>{note}</p>}
      </>
    );
  }
  return (
    <>
      <select id={id} name={name} value={value} onChange={(e) => onChange(e.target.value)} className={inputClass} required>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {note && <p className={noteClass ?? 'text-xs text-muted mt-1'}>{note}</p>}
    </>
  );
}
