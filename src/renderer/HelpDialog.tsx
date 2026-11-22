import { useEffect, useState } from 'react'
import { HELP } from '../core/help'
import { useStore } from './store'
import { useEscape } from './lib/useEscape'

function Body({ text }: { text: string }) {
  const blocks = text.split(/\n\n+/)
  return (
    <>
      {blocks.map((b, i) => {
        const lines = b.split('\n')
        if (lines.every((l) => /^- /.test(l))) return <ul key={i}>{lines.map((l, j) => <li key={j}>{l.slice(2)}</li>)}</ul>
        if (lines.every((l) => /^\d+\. /.test(l))) return <ol key={i}>{lines.map((l, j) => <li key={j}>{l.replace(/^\d+\. /, '')}</li>)}</ol>
        return <p key={i} className="hint" style={{ whiteSpace: 'pre-wrap' }}>{b}</p>
      })}
    </>
  )
}

export function HelpDialog() {
  const topic = useStore((s) => s.helpOpen)
  const [id, setId] = useState('start')
  useEffect(() => { if (topic) setId(topic) }, [topic])
  const close = () => useStore.getState().setHelpOpen(null)
  useEscape(close)
  if (!topic) return null
  const t = HELP.find((x) => x.id === id) ?? HELP[0]
  return (
    <div className="modal-back" onClick={close}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()} style={{ display: 'grid', gridTemplateColumns: '170px 1fr', gap: 16 }}>
        <nav style={{ display: 'grid', gap: 4, alignContent: 'start' }}>
          {HELP.map((x) => <button key={x.id} className={x.id === t.id ? 'on' : ''} onClick={() => setId(x.id)} style={{ textAlign: 'left' }}>{x.title}</button>)}
        </nav>
        <div>
          <h2>{t.title}</h2>
          <Body text={t.body} />
          <div className="modal-actions"><button onClick={close}>Close</button></div>
        </div>
      </div>
    </div>
  )
}
