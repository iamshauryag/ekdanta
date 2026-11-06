// Where the vault is. Kept apart from vault.ts so any server module (settings, say) can import it
// without importing the whole vault layer.
import path from 'node:path'

// `npm run dev` runs from app/, so the bundled sample vault is the default.
export const VAULT = path.resolve(process.env.EKDANTA_VAULT ?? 'sample-vault')
/** Ekdanta's own notes about the vault: settings, the Recall index, history, trash. */
export const META_DIR = path.join(VAULT, '.ekdanta')
