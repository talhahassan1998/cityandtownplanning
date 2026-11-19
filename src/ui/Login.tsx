import { useState, type ReactNode } from 'react'
import { Eye, EyeOff, FilePlus2, IdCard, LifeBuoy, LockKeyhole, LogIn, Map as MapIcon, Navigation2, User, Waypoints } from 'lucide-react'
import { login, register, serverUp, useSession } from '../api'

// Decorative master-plan backdrop: tilted parcel grids, transit lines, a river. Pure SVG, no data.
type Block = [x: number, y: number, cols: number, rows: number, rot: number, filled: number[], label?: [number, string]]
const BLOCKS: Block[] = [
  [0, 40, 6, 5, -12, [1, 2, 8, 14, 15, 21], [1, 'C-1']], [470, 28, 9, 1, 0, [6, 8]], [1150, 10, 6, 5, 18, [0, 7, 13, 20, 25]],
  [80, 410, 4, 3, 6, [4, 1, 6, 10], [4, 'R-2']], [380, 450, 1, 3, 8, [0, 1, 2]], [1150, 380, 4, 3, -4, [1, 2, 6]],
  [490, 750, 9, 2, -3, [0, 2, 4], [2, 'C-1']], [1310, 440, 1, 1, 0, [0], [0, 'I-1']],
]
const W = 64, H = 50, G = 10
const LINES = ['M120 8 L330 178 L570 238', 'M40 795 L300 555 L558 436', 'M1555 36 L1295 246 L1036 346', 'M1030 572 L1235 615 L1500 828']

function Backdrop() {
  return (
    <svg className="absolute inset-0 h-full w-full" viewBox="0 0 1590 828" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <defs>
        <radialGradient id="lg-glow" cx="50%" cy="45%" r="60%"><stop offset="0" stopColor="#14343a" /><stop offset="1" stopColor="#0a1417" /></radialGradient>
      </defs>
      <rect width="1590" height="828" fill="url(#lg-glow)" />
      <circle cx="795" cy="420" r="560" fill="none" stroke="#3a6a70" strokeOpacity=".35" strokeDasharray="2 6" />
      {BLOCKS.map(([x, y, cols, rows, rot, filled, label], b) => (
        <g key={b} transform={`translate(${x} ${y}) rotate(${rot})`}>
          {Array.from({ length: cols * rows }, (_, i) => {
            const cx = (i % cols) * (W + G), cy = Math.floor(i / cols) * (H + G), on = filled.includes(i)
            return (
              <g key={i}>
                <rect x={cx} y={cy} width={W} height={H} rx="2" fill={on ? '#1f7f8c' : 'none'} fillOpacity={on ? 0.55 : 0} stroke="#4c8c94" strokeOpacity=".45" />
                {!on && i % 3 === 0 && <line x1={cx + W / 2} y1={cy} x2={cx + W / 2} y2={cy + H} stroke="#4c8c94" strokeOpacity=".3" />}
                {label?.[0] === i && <text x={cx + 6} y={cy + 14} fontSize="9" fill="#9fd0d6" opacity=".8">{label[1]}</text>}
              </g>
            )
          })}
        </g>
      ))}
      <path d="M0 655 C 300 610, 520 720, 800 690 S 1250 600, 1590 690 L1590 740 C 1250 650, 1000 760, 800 740 S 300 660, 0 705 Z" fill="#1a6d78" fillOpacity=".35" />
      {LINES.map((d, i) => (
        <g key={i}>
          <path d={d} fill="none" stroke={i % 2 ? '#2fa7b6' : '#c9dfe2'} strokeOpacity=".7" strokeWidth="1.5" />
          {d.match(/\d+ \d+/g)!.map((p, j) => { const [x, y] = p.split(' '); return <circle key={j} cx={x} cy={y} r="4" fill="#d8eef0" /> })}
        </g>
      ))}
    </svg>
  )
}

function Field({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <label className="flex h-13 items-center rounded-lg border border-white/5 bg-[#08161a]/90 focus-within:border-[#2fa7b6]">
      <span className="grid h-full w-13 place-items-center border-r border-white/5 text-[#c9dfe2]">{icon}</span>
      {children}
    </label>
  )
}

const input = 'h-full min-w-0 flex-1 bg-transparent px-4 text-[15px] text-[#e4eef0] placeholder-[#8fa6aa] outline-none'
const primary = 'flex h-13 w-full items-center justify-center gap-2 rounded-full text-sm tracking-[0.15em] disabled:opacity-60'

/** Planner login / applicant registration against the API's accounts (backend/app/auth.py). */
export default function Login() {
  const user = useSession((s) => s.user)
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const reg = mode === 'register'

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget), v = (k: string) => String(f.get(k) ?? '')
    if (reg && v('password') !== v('confirm')) return setNote('The passwords don’t match.')
    setBusy(true); setNote('')
    try {
      await (reg ? register(v('username'), v('name'), v('password')) : login(v('username'), v('password'), f.get('remember') === 'on'))
      history.replaceState(null, '', location.pathname + location.search) // drop #login
      dispatchEvent(new HashChangeEvent('hashchange'))
    } catch (err) {
      const offline = !(await serverUp())
      if (offline) useSession.setState({ user: 'offline' })
      setNote(offline ? 'The server isn’t running (docker compose up -d), so accounts are unavailable.' : (err as Error).message)
    } finally { setBusy(false) }
  }

  return (
    <div className="relative min-h-full overflow-hidden bg-[#0a1417] font-['Poppins',var(--font-sans)] text-[#e4eef0]">
      <Backdrop />

      <header className="absolute inset-x-0 top-0 flex items-center justify-between px-6 py-5 text-sm">
        <span className="flex items-center gap-2 font-medium text-[#c9dfe2]"><Waypoints size={18} className="text-[#2fa7b6]" />City &amp; Town Planning</span>
        <button type="button" onClick={() => setNote('Planners sign in with their username. Applicants register to file permits and site plans. The first account on a new server becomes a planner.')} className="flex items-center gap-1.5 text-[#c9dfe2]"><LifeBuoy size={15} />help</button>
      </header>

      <main className="relative grid min-h-screen place-items-center px-4 py-24">
        <form onSubmit={submit} className="w-full max-w-[460px] rounded-2xl border border-white/10 bg-[#1b3b41]/70 px-6 py-12 shadow-2xl backdrop-blur-md sm:px-11">
          <p className="flex items-center justify-center gap-2 text-[11px] font-semibold tracking-[0.2em] text-[#c9dfe2]"><MapIcon size={14} />DEVELOPMENT SERVICES PORTAL</p>
          <h1 className="mt-3 text-center text-[26px] tracking-[0.12em]"><span className="font-light text-[#cfe3e6]">{reg ? 'APPLICANT' : 'PLANNER'}</span> <span className="font-bold">{reg ? 'REGISTER' : 'LOGIN'}</span></h1>
          {user && user !== 'offline' && <p className="mt-2 text-center text-xs text-[#9fc3c8]">Signed in as {user.name} · <a href="#" className="underline">back to the editor</a></p>}

          <div className="mt-9 space-y-5">
            {reg && <Field icon={<IdCard size={18} />}><input key="name" className={input} name="name" aria-label="Full name" autoComplete="name" placeholder="Full name" maxLength={100} required /></Field>}
            <Field icon={<User size={18} />}><input className={input} name="username" aria-label="Username" autoComplete="username" placeholder={reg ? 'Choose a username' : 'Username or employee ID'} minLength={3} maxLength={40} pattern={reg ? '[A-Za-z0-9._\-]+' : undefined} title={reg ? 'Letters, digits, dots, dashes or underscores' : undefined} required /></Field>
            <Field icon={<LockKeyhole size={18} />}>
              <input key={mode} className={input} name="password" aria-label="Password" type={show ? 'text' : 'password'} autoComplete={reg ? 'new-password' : 'current-password'} placeholder={reg ? 'Password (8+ characters)' : 'Password'} minLength={reg ? 8 : 1} required />
              <button type="button" onClick={() => setShow(!show)} className="px-4 text-[#c9dfe2]" aria-label={show ? 'Hide password' : 'Show password'}>{show ? <EyeOff size={18} /> : <Eye size={18} />}</button>
            </Field>
            {reg && <Field icon={<LockKeyhole size={18} />}><input className={input} name="confirm" aria-label="Repeat password" type={show ? 'text' : 'password'} autoComplete="new-password" placeholder="Repeat password" required /></Field>}
          </div>

          {!reg && (
            <div className="mt-5 flex items-center justify-between text-sm">
              <label className="flex items-center gap-2 text-[#c9dfe2]"><input type="checkbox" name="remember" className="size-4 accent-[#2fa7b6]" />Remember me</label>
              <button type="button" onClick={() => setNote('Password reset isn’t available yet: it needs an email service or an admin screen (planned).')} className="text-[#7fd3dd] hover:underline">Forgot password?</button>
            </div>
          )}

          <button disabled={busy} className={`${primary} mt-7 ${reg ? 'bg-[#17899a] font-semibold hover:brightness-110' : 'bg-[#e6eef0] font-medium text-[#0f2328] hover:bg-white'}`}>
            {reg ? <FilePlus2 size={18} /> : <LogIn size={18} />}{busy ? 'PLEASE WAIT…' : reg ? 'CREATE ACCOUNT' : 'LOGIN'}
          </button>

          <div className="my-6 flex items-center gap-3 text-[13px] text-[#c9dfe2]"><span className="h-px flex-1 bg-white/15" />{reg ? 'Already registered' : 'New applicant'}<span className="h-px flex-1 bg-white/15" /></div>

          <button type="button" onClick={() => { setMode(reg ? 'login' : 'register'); setNote('') }} className={`${primary} ${reg ? 'bg-[#e6eef0] font-medium text-[#0f2328] hover:bg-white' : 'bg-[#17899a] font-semibold hover:brightness-110'}`}>
            {reg ? <><LogIn size={18} />BACK TO LOGIN</> : <><FilePlus2 size={18} />REGISTER</>}
          </button>
          <p className="mt-4 text-center text-[13px] text-[#c9dfe2]">Register to file building permits and site plans.</p>
          {note && <p role="status" className="mt-4 rounded-lg bg-black/30 px-3 py-2 text-center text-xs text-[#ffcf9e]">{note}{user === 'offline' && <> <a href="#" className="underline">Continue offline</a></>}</p>}
        </form>
      </main>

      <footer className="absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-3 px-6 py-5 text-[13px] text-[#c9dfe2]">
        <ul className="flex flex-wrap items-center gap-5">
          <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-[#2fa7b6]" />Residential</li>
          <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-[#1f7f8c]/70" />Mixed use</li>
          <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm border border-[#c9dfe2]" />Parcel boundary</li>
          <li className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-[#d8eef0]" />Transit node</li>
        </ul>
        <span className="flex items-end gap-4">Master Plan 2041 · Sheet 03 · 1:5000 <span className="flex flex-col items-center text-[10px]">N<Navigation2 size={20} className="fill-current" /></span></span>
      </footer>
    </div>
  )
}
