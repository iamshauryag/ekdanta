// Line icons on a 20px grid, 1.5px stroke (see DESIGN.md · Icons).
const PATHS: Record<string, string[]> = {
  folder: ['M3.5 5.5a1.5 1.5 0 011.5-1.5h3l1.5 2H15a1.5 1.5 0 011.5 1.5v7A1.5 1.5 0 0115 16H5a1.5 1.5 0 01-1.5-1.5z'],
  focus: ['M3.5 7V4.5a1 1 0 011-1H7', 'M13 3.5h2.5a1 1 0 011 1V7', 'M16.5 13v2.5a1 1 0 01-1 1H13', 'M7 16.5H4.5a1 1 0 01-1-1V13'],
  panel: ['M4.5 4.5h11a1 1 0 011 1v9a1 1 0 01-1 1h-11a1 1 0 01-1-1v-9a1 1 0 011-1z', 'M12 4.5v11'],
  material: ['M4 6.5l6-3 6 3-6 3z', 'M4 10l6 3 6-3', 'M4 13.5l6 3 6-3'],
  history: ['M10 3.5a6.5 6.5 0 110 13 6.5 6.5 0 010-13z', 'M10 6.5V10l2.5 1.75'],
  piece: ['M5.5 3.5h6l3 3v10h-9z', 'M11.5 3.5v3h3', 'M8 10h4M8 12.5h4'],
  plus: ['M10 4.5v11M4.5 10h11'],
}

export function Icon({ name }: { name: keyof typeof PATHS | string }) {
  return (
    <svg className="icon" viewBox="0 0 20 20" aria-hidden="true">
      {(PATHS[name] ?? []).map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  )
}
