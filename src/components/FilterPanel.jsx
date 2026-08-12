/**
 * Layer toggles.
 *
 * Capped rather than unlimited: six simultaneous layers on one globe is not a
 * richer view, it is an unreadable one - falling rain, drifting snow, flowing
 * wind and two surface washes all compete for the same pixels. The cap is
 * enforced as "oldest selection drops off" so a tap always does something,
 * instead of silently refusing the input.
 */

export const LAYERS = [
  { id: 'wind', label: 'Wind' },
  { id: 'rain', label: 'Rain' },
  { id: 'thunder', label: 'Thunderstorms' },
  { id: 'snow', label: 'Snow' },
  { id: 'clear', label: 'Clear' },
  { id: 'clouds', label: 'Clouds' },
];

export default function FilterPanel({ active, onToggle, maxActive }) {
  return (
    <div className="filters">
      <div className="filters__row" role="group" aria-label="Weather layers">
        {LAYERS.map((layer) => {
          const on = active.includes(layer.id);
          return (
            <button
              key={layer.id}
              type="button"
              className={on ? 'chip chip--on' : 'chip'}
              aria-pressed={on}
              onClick={() => onToggle(layer.id)}
            >
              {layer.label}
            </button>
          );
        })}
      </div>
      <p className="filters__hint">
        {maxActive === 1
          ? 'Reduced quality - one layer at a time'
          : `Up to ${maxActive} layers at once`}
      </p>
    </div>
  );
}
