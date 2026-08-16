/**
 * Layer toggles.
 *
 * Capped rather than unlimited: six simultaneous layers on one globe is not a
 * richer view, it is an unreadable one - falling rain, drifting snow, flowing
 * wind and two surface washes all compete for the same pixels. The cap is
 * enforced as "oldest selection drops off" so a tap always does something,
 * instead of silently refusing the input.
 */

/**
 * Aurora is the one exclusive entry. The others are washes over a daylit Earth
 * and combine happily; Aurora rebuilds the whole scene around a dark one, so
 * running it alongside rain or a sunny glow would mean lighting the globe and
 * unlighting it at the same time. Selecting it clears the rest, and leaving it
 * puts them back - see `handleToggleLayer` in App.jsx.
 */
export const AURORA_LAYER = 'aurora';

export const LAYERS = [
  { id: 'wind', label: 'Wind' },
  { id: 'rain', label: 'Rain' },
  { id: 'thunder', label: 'Thunderstorms' },
  { id: 'snow', label: 'Snow' },
  { id: 'clear', label: 'Clear' },
  { id: 'clouds', label: 'Clouds' },
  { id: AURORA_LAYER, label: 'Aurora' },
];

export default function FilterPanel({ active, onToggle, maxActive }) {
  const auroraOn = active.includes(AURORA_LAYER);

  return (
    <div className="filters">
      <div className="filters__row" role="group" aria-label="Weather layers">
        {LAYERS.map((layer) => {
          const on = active.includes(layer.id);
          const isAurora = layer.id === AURORA_LAYER;
          return (
            <button
              key={layer.id}
              type="button"
              className={[
                'chip',
                on ? 'chip--on' : '',
                // Tinted to the colour it actually paints on the globe, so the
                // one control that behaves differently also looks different.
                isAurora ? 'chip--aurora' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              aria-pressed={on}
              onClick={() => onToggle(layer.id)}
            >
              {layer.label}
            </button>
          );
        })}
      </div>
      <p className="filters__hint">
        {auroraOn
          ? 'Aurora runs on its own - pick another layer to return'
          : maxActive === 1
            ? 'Reduced quality - one layer at a time'
            : `Up to ${maxActive} layers at once`}
      </p>
    </div>
  );
}
