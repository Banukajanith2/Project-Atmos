import { useEffect, useId, useRef, useState } from 'react';
import { useCitySearch } from '../hooks/useCitySearch';

/**
 * City search with an explicit disambiguation list.
 *
 * There is deliberately no "I feel lucky" path that jumps straight to the top
 * hit on Enter when several matches exist. "Springfield" matches a dozen real
 * places across several countries, and silently flying to the most populous one
 * is a wrong answer delivered confidently. Every row shows region and country,
 * and a choice is always made explicitly.
 */
export default function SearchBar({ onSelect, selected, onClear }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const { results, status, error } = useCitySearch(query);
  const containerRef = useRef(null);
  const listId = useId();

  useEffect(() => setHighlight(0), [results]);

  // Clicking anywhere else dismisses the dropdown.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!containerRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const choose = (place) => {
    onSelect(place);
    setQuery('');
    setOpen(false);
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      setOpen(false);
      event.currentTarget.blur();
      return;
    }
    if (!results.length) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setHighlight((h) => (h + 1) % results.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setHighlight((h) => (h - 1 + results.length) % results.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(results[highlight]);
    }
  };

  const showDropdown = open && query.trim().length >= 2;

  return (
    <div className="search" ref={containerRef}>
      <div className="search__field">
        <svg className="search__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" strokeLinecap="round" />
        </svg>
        <input
          type="text"
          className="search__input"
          placeholder="Search a city…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label="Search for a city"
        />
        {status === 'searching' && <span className="search__spinner" aria-hidden="true" />}
        {selected && !query && (
          <button type="button" className="search__clear" onClick={onClear} aria-label="Clear selected city">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        )}
      </div>

      {showDropdown && (
        <ul className="search__results" id={listId} role="listbox">
          {results.map((place, index) => (
            <li key={place.id ?? `${place.latitude},${place.longitude}`} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={index === highlight}
                className={index === highlight ? 'search__result search__result--active' : 'search__result'}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => choose(place)}
              >
                <span className="search__city">{place.name}</span>
                {/* Region and country are never omitted - they are the whole
                    point of showing a list rather than auto-picking. */}
                <span className="search__region">
                  {[place.admin1, place.country].filter(Boolean).join(', ')}
                </span>
              </button>
            </li>
          ))}

          {status === 'done' && results.length === 0 && (
            <li className="search__empty">No places match “{query.trim()}”.</li>
          )}
          {status === 'error' && <li className="search__empty">Search failed. {error}</li>}
        </ul>
      )}
    </div>
  );
}
