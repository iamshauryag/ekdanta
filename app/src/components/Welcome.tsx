import { useState } from 'react'
import { kinds } from '../lib/kinds.ts'

interface Props {
  vault: string
  /** Start a new draft of this kind. */
  onStart: (kind: string) => void
  onImport: () => void
  /** Copy the sample pieces in. Resolves once they're there; rejects with the reason if not. */
  onSample: () => Promise<void>
}

/** What an empty vault shows: where it is, and three ways to begin. */
export function Welcome({ vault, onStart, onImport, onSample }: Props) {
  const [step, setStep] = useState<'start' | 'kind' | 'sample' | 'copying'>('start')
  const [error, setError] = useState<string | null>(null)
  const sample = async () => {
    setStep('copying')
    setError(null)
    try {
      await onSample()
    } catch (e) {
      setError((e as Error).message)
      setStep('start')
    }
  }
  return (
    <section className="welcome" aria-labelledby="welcome-title">
      <h1 id="welcome-title">Nothing here yet</h1>
      <p className="welcome-lede">Your vault is a folder of Markdown files. Write something new, or bring in what you’ve already written: Word documents, web pages, text and Markdown files.</p>
      <p className="welcome-path" title="Your vault">
        {vault}
      </p>
      {step === 'kind' ? (
        <div className="welcome-kinds" role="group" aria-label="What are you writing?">
          <span className="muted">What are you writing?</span>
          <div className="welcome-chips">
            {kinds().map((k) => (
              <button key={k.id} className="btn" onClick={() => onStart(k.id)}>
                {k.name}
              </button>
            ))}
          </div>
          <button className="welcome-back" onClick={() => setStep('start')}>
            Back
          </button>
        </div>
      ) : step === 'sample' || step === 'copying' ? (
        <div className="welcome-confirm" role="group" aria-label="Open the sample vault">
          <p>Copy a few sample essays, posts and notes into this vault? They’re yours to edit or delete.</p>
          <div className="welcome-actions">
            <button className="btn primary" disabled={step === 'copying'} onClick={sample}>
              {step === 'copying' ? 'Copying…' : 'Copy the samples'}
            </button>
            <button className="btn" disabled={step === 'copying'} onClick={() => setStep('start')}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="welcome-actions">
          <button className="btn primary" onClick={() => setStep('kind')}>
            Start writing
          </button>
          <button className="btn" onClick={onImport}>
            Import files
          </button>
          <button className="btn" onClick={() => setStep('sample')}>
            Open the sample vault
          </button>
        </div>
      )}
      {error && (
        <p className="welcome-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

/** The vault can't be opened at all: where it is, why, and a way to try again. */
export function VaultError({ vault, reason, onRetry }: { vault: string; reason: string; onRetry: () => void }) {
  return (
    <section className="welcome is-error" role="alert" aria-labelledby="vault-error-title">
      <h1 id="vault-error-title">Ekdanta can’t open your vault</h1>
      <p className="welcome-lede">{reason}</p>
      {vault && <p className="welcome-path">{vault}</p>}
      <p className="muted">
        The vault is the folder in <code>EKDANTA_VAULT</code>. Point it at a folder you can write to (Ekdanta creates it if it doesn’t exist), then restart, or fix the folder and try again.
      </p>
      <div className="welcome-actions">
        <button className="btn primary" onClick={onRetry}>
          Try again
        </button>
      </div>
    </section>
  )
}
