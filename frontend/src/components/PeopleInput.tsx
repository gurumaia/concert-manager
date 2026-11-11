import { useId, useState, type KeyboardEvent } from "react";
import { addCompanions, suggestPeople, type Person } from "../history";

/** Names as removable chips plus a text box. Enter or comma adds, Backspace on an empty box removes the last, and people from other shows are suggested. */
export function PeopleInput({ value, onChange, people, label }: { value: string[]; onChange: (v: string[]) => void; people: Person[]; label: string }) {
  const id = useId();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const options = open ? suggestPeople(people, text, value) : [];

  const add = (raw: string) => { onChange(addCompanions(value, raw)); setText(""); setActive(-1); };

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" && options.length) { e.preventDefault(); setActive((active + 1) % options.length); }
    else if (e.key === "ArrowUp" && options.length) { e.preventDefault(); setActive((active - 1 + options.length) % options.length); }
    else if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); }
    else if (e.key === "Enter" || e.key === ",") {
      if (e.key === "Enter" || text.trim()) e.preventDefault(); // Enter must not submit an enclosing form
      const pick = active >= 0 ? options[active] : undefined;
      if (pick) add(pick); else if (text.trim()) add(text);
    } else if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1));
  }

  return (
    <div className="people" role="group" aria-labelledby={`${id}-l`}>
      <span id={`${id}-l`} className="people-label">{label}</span>
      <div className="people-box">
        {value.map((n) => (
          <span key={n} className="chip">{n}
            <button type="button" aria-label={`Remove ${n}`} className="icon-btn" onClick={() => onChange(value.filter((x) => x !== n))}>×</button>
          </span>
        ))}
        <input
          role="combobox" aria-expanded={options.length > 0} aria-controls={`${id}-list`} aria-autocomplete="list" aria-labelledby={`${id}-l`}
          aria-activedescendant={active >= 0 ? `${id}-o${active}` : undefined}
          value={text} placeholder={value.length ? "Add another" : "Type a name, press Enter"} autoComplete="off"
          onChange={(e) => { setText(e.target.value); setOpen(true); setActive(-1); }}
          onFocus={() => setOpen(true)}
          onBlur={() => { setOpen(false); if (text.trim()) add(text); }}
          onKeyDown={onKeyDown}
        />
      </div>
      {options.length > 0 && (
        <ul id={`${id}-list`} role="listbox" className="people-list">
          {options.map((n, i) => (
            // mousedown (not click) so the pick lands before the input's blur closes the list
            <li key={n} id={`${id}-o${i}`} role="option" aria-selected={i === active} className={i === active ? "on" : ""} onMouseDown={(e) => { e.preventDefault(); add(n); }}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
