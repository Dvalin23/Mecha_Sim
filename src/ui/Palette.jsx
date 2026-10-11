import { useMemo, useState } from 'react'
import { paletteGroups } from '../engine/registry.js'
import { groupColors } from '../engine/draw/palette.js'

/**
 * Parts palette. Clicking adds the part at the centre of the view; dragging
 * drops it exactly where the pointer is (the `drop` handler converts screen →
 * world through the camera, so a part lands under the cursor at any zoom).
 *
 * The palette is generated from the component registry, so a new device class
 * appears here the moment it is registered — no UI change required.
 */
export function Palette({ onAdd }) {
  const groups = useMemo(() => paletteGroups(), [])
  const [query, setQuery] = useState('')

  const needle = query.trim().toLowerCase()

  return (
    <aside className="palette">
      <div style={{ padding: '10px 12px 4px' }}>
        <input
          type="text"
          placeholder="Search parts…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          style={{ width: '100%' }}
        />
      </div>

      {groups.map(({ group, items }) => {
        const visible = needle
          ? items.filter((item) =>
              `${item.label} ${item.type} ${item.description}`.toLowerCase().includes(needle),
            )
          : items
        if (!visible.length) return null
        return (
          <section key={group}>
            <div className="section-title" style={{ color: groupColors[group] ?? undefined }}>
              {group}
            </div>
            {visible.map((item) => (
              <div
                key={item.type}
                className="palette-item"
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData('text/mechasim-type', item.type)
                  event.dataTransfer.effectAllowed = 'copy'
                }}
                onClick={() => onAdd(item.type)}
                title={item.description}
              >
                <span className="glyph" style={{ color: item.accent }}>
                  {item.icon}
                </span>
                <span>
                  <span className="label">{item.label}</span>
                  <br />
                  <span className="desc">{item.description}</span>
                </span>
              </div>
            ))}
          </section>
        )
      })}
    </aside>
  )
}
