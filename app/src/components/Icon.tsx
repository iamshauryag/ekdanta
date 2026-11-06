// Line icons on a 20px grid, 1.5px stroke (see DESIGN.md · Icons).
const PATHS: Record<string, string[]> = {
  folder: ['M3.5 5.5a1.5 1.5 0 011.5-1.5h3l1.5 2H15a1.5 1.5 0 011.5 1.5v7A1.5 1.5 0 0115 16H5a1.5 1.5 0 01-1.5-1.5z'],
  focus: ['M3.5 7V4.5a1 1 0 011-1H7', 'M13 3.5h2.5a1 1 0 011 1V7', 'M16.5 13v2.5a1 1 0 01-1 1H13', 'M7 16.5H4.5a1 1 0 01-1-1V13'],
  panel: ['M4.5 4.5h11a1 1 0 011 1v9a1 1 0 01-1 1h-11a1 1 0 01-1-1v-9a1 1 0 011-1z', 'M12 4.5v11'],
  material: ['M4 6.5l6-3 6 3-6 3z', 'M4 10l6 3 6-3', 'M4 13.5l6 3 6-3'],
  history: ['M10 3.5a6.5 6.5 0 110 13 6.5 6.5 0 010-13z', 'M10 6.5V10l2.5 1.75'],
  piece: ['M5.5 3.5h6l3 3v10h-9z', 'M11.5 3.5v3h3', 'M8 10h4M8 12.5h4'],
  compose: ['M9.5 4.5h-4a1 1 0 00-1 1v9a1 1 0 001 1h9a1 1 0 001-1v-4', 'M14.25 3.75a1.4 1.4 0 012 2L10.5 11.5l-2.5.5.5-2.5z'],
  settings: ['M10 7.25a2.75 2.75 0 110 5.5 2.75 2.75 0 010-5.5z', 'M10 2.75v2M10 15.25v2M2.75 10h2M15.25 10h2M4.87 4.87l1.42 1.42M13.71 13.71l1.42 1.42M4.87 15.13l1.42-1.42M13.71 6.29l1.42-1.42'],
  star: ['M10 3.25l2.05 4.15 4.58.67-3.32 3.23.79 4.56L10 13.7l-4.1 2.16.79-4.56-3.32-3.23 4.58-.67z'],
  voice: ['M4 9v2', 'M7 6.5v7', 'M10 4v12', 'M13 6.5v7', 'M16 9v2'],
  plus: ['M10 4.5v11M4.5 10h11'],
  more: ['M5.5 10h.01M10 10h.01M14.5 10h.01'],
  bold: ['M6.5 4.5h4.75a2.75 2.75 0 010 5.5H6.5z', 'M6.5 10h5.5a3 3 0 010 6H6.5z'],
  italic: ['M9 4.5h6', 'M5 15.5h6', 'M12.5 4.5l-4 11'],
  underline: ['M6 4v5.5a4 4 0 008 0V4', 'M5 16.5h10'],
  strike: ['M13.6 5.6C12.9 4.7 11.6 4.2 10 4.2c-2.2 0-3.6 1.1-3.6 2.7 0 .9.4 1.6 1.2 2.1', 'M4 10h12', 'M12.8 11.6c.5.5.8 1.1.8 1.8 0 1.6-1.5 2.6-3.6 2.6-1.8 0-3.2-.6-3.9-1.7'],
  undo: ['M7.5 5L4 8.5 7.5 12', 'M4.5 8.5h7a4 4 0 010 8H9'],
  redo: ['M12.5 5L16 8.5 12.5 12', 'M15.5 8.5h-7a4 4 0 000 8H11'],
  link: ['M8.5 11.5a3 3 0 004.24 0l2.5-2.5a3 3 0 00-4.24-4.24l-.75.75', 'M11.5 8.5a3 3 0 00-4.24 0l-2.5 2.5a3 3 0 004.24 4.24l.75-.75'],
  bullets: ['M8 6h8M8 10h8M8 14h8', 'M4.5 6h.01M4.5 10h.01M4.5 14h.01'],
  numbers: ['M9 6h7M9 10h7M9 14h7', 'M4 5l1-.5V8M4 8h2', 'M4 12.2a1 1 0 011.9.3c0 .9-1.9 1.4-1.9 2.5h2'],
  todo: ['M4 5.5h3.5V9H4z', 'M4 12h3.5v3.5H4z', 'M4.6 13.7l.9.9 1.6-1.9', 'M10 7.25h6M10 13.75h6'],
  outdent: ['M9 6h7M9 10h7M9 14h7M4 6h1.5', 'M6.5 8L4 10l2.5 2'],
  indent: ['M9 6h7M9 10h7M9 14h7M4 6h1.5', 'M4 8l2.5 2L4 12'],
  code: ['M7.5 6L3.5 10l4 4', 'M12.5 6l4 4-4 4'],
  highlight: ['M11.5 4.5l4 4-6 6H5.5v-4z', 'M4 17h12'],
  divider: ['M3.5 10h13', 'M6 6h8M6 14h8'],
  table: ['M3.5 5h13v10h-13z', 'M3.5 8.5h13M3.5 12h13M10 5v10'],
  image: ['M4 4.5h12v11H4z', 'M4 13l3.5-3.5 3 3 2-2L16 14', 'M12.5 7.5h.01'],
  clear: ['M5 5h9M9.5 5l-2 10', 'M12 12l4 4M16 12l-4 4'],
  search: ['M9 4a5 5 0 110 10 5 5 0 010-10z', 'M12.6 12.6L16 16'],
  markdown: ['M3.5 5.5h13v9h-13z', 'M6 12V8l1.75 2L9.5 8v4', 'M13 8v4M11.5 10.5L13 12l1.5-1.5'],
  outline: ['M4 5.5h12M6 9h10M8 12.5h8M6 16h10'],
}

// Bold reads as bold only drawn heavier than the other glyphs.
const WEIGHT: Record<string, number> = { bold: 2.1 }

export function Icon({ name }: { name: keyof typeof PATHS | string }) {
  return (
    <svg className="icon" viewBox="0 0 20 20" aria-hidden="true" style={WEIGHT[name] ? { strokeWidth: WEIGHT[name] } : undefined}>
      {(PATHS[name] ?? []).map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  )
}
