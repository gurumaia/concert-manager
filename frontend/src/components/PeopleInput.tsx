import { useId, useState, type KeyboardEvent } from "react";
import { addCompanions, chipOf, EMAIL_RE, personKey, suggestPeople, type Person } from "../history";

/**
 * People as removable chips plus a text box. Enter or comma adds, Backspace on an empty box removes the last, and people from other shows are suggested.
 * Type a name, or an email ("ana@x.com", "Ana <ana@x.com>"): a person with an email is linked, so the show is shared with them. Green chips are linked;
 * "+ email" on a plain chip links it. Entries are plain names, or "Name <email>" while the email is not saved yet.
 */
export function PeopleInput({ value, onChange, people, label }: { value: string[]; onChange: (v: string[]) => void; people: Person[]; label: string }) {
  const id = useId();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [linking, setLinking] = useState<string>(); // the entry whose email is being typed
  const [mail, setMail] = useState("");
  const options = open ? suggestPeople(people, text, value) : [];

  const add = (raw: string) => { onChange(addCompanions(value, raw, people)); setText(""); setActive(-1); };
  const link = (entry: string, email: string) => {
    const c = chipOf(entry, people);
    onChange(value.map((x) => (x === entry ? `${c.name} <${email.trim().toLowerCase()}>` : x)));
    setLinking(undefined); setMail("");
  };

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
        {value.map((entry) => {
          const c = chipOf(entry, people);
          return (
            <span key={entry} className={`chip${c.email ? " linked" : ""}`}>
              {c.email ? <span title={`Shared with ${c.email}`}>{c.name} · {c.email}</span> : c.name}
              {!c.email && (linking === entry ? (
                <input
                  type="email" autoFocus className="chip-mail" aria-label={`Email for ${c.name}`} placeholder="name@example.com" value={mail}
                  onChange={(e) => setMail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); if (EMAIL_RE.test(mail.trim())) link(entry, mail); }
                    else if (e.key === "Escape") { e.stopPropagation(); setLinking(undefined); setMail(""); }
                  }}
                  onBlur={() => { if (EMAIL_RE.test(mail.trim())) link(entry, mail); else { setLinking(undefined); setMail(""); } }}
                />
              ) : (
                <button type="button" className="chip-add" aria-label={`Add email for ${c.name}`} title="Add an email to share this show with them" onClick={() => { setLinking(entry); setMail(""); }}>+ email</button>
              ))}
              <button type="button" aria-label={`Remove ${c.name}`} className="icon-btn" onClick={() => onChange(value.filter((x) => x !== entry))}>×</button>
            </span>
          );
        })}
        <input
          role="combobox" aria-expanded={options.length > 0} aria-controls={`${id}-list`} aria-autocomplete="list" aria-labelledby={`${id}-l`}
          aria-activedescendant={active >= 0 ? `${id}-o${active}` : undefined}
          value={text} placeholder={value.length ? "Add another (name or email)" : "Type a name or email, press Enter"} autoComplete="off"
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
            <li key={n} id={`${id}-o${i}`} role="option" aria-selected={i === active} className={i === active ? "on" : ""} onMouseDown={(e) => { e.preventDefault(); add(n); }}>
              <span>{n}</span><span className="muted small">{people.find((p) => p.key === personKey(n))?.email ?? "no email yet"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
