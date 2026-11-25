import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'
import type {
  CalendarEvent,
  ScheduleEntry,
  Session,
  StoredToken,
  TaskItem,
  TokenClient,
  TokenResponse,
  WeatherNow,
} from './types'

const CLIENT_ID_KEY = 'deskPlanner.clientId'
const TOKEN_KEY = 'deskPlanner.token'
const GOOGLE_SCOPES =
  'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/tasks'
const CALENDAR_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
const TASKS_URL = 'https://tasks.googleapis.com/tasks/v1/lists/@default/tasks'
const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast'
const MANCHESTER = { latitude: 53.48, longitude: -2.24 }
const POLL_INTERVAL_MS = 3 * 60 * 1000
const RENEW_BEFORE_EXPIRY_MS = 2 * 60 * 1000

// module code -> readable name, e.g. '6G6Z0058': 'Whatever the module is called'
const moduleNames: Record<string, string> = {}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

class UnauthorizedError extends Error {}

const pad = (value: number) => String(value).padStart(2, '0')
const formatClock = (moment: Date) => `${pad(moment.getHours())}:${pad(moment.getMinutes())}`
const formatDate = (moment: Date) =>
  `${WEEKDAYS[moment.getDay()]} ${moment.getDate()} ${MONTHS[moment.getMonth()]}`
const startOfDay = (moment: Date) =>
  new Date(moment.getFullYear(), moment.getMonth(), moment.getDate())
const addDays = (moment: Date, days: number) =>
  new Date(moment.getFullYear(), moment.getMonth(), moment.getDate() + days)

function cleanEventTitle(rawTitle: string): string {
  const stripped = rawTitle
    .replace(/\b[A-Z0-9]{6,10}_\d{4}_SEM\d\S*/gi, '')
    .replace(/\s*[-–—]\s*$/, '')
    .trim()

  const prefixed = stripped.match(/^[0-9][A-Z0-9]{7}\s*[-–—:]\s*(.+)$/i)
  if (prefixed) return prefixed[1].trim()

  return moduleNames[stripped.toUpperCase()] ?? (stripped || rawTitle.trim() || 'Untitled event')
}

function toScheduleEntry(event: CalendarEvent): ScheduleEntry {
  if (event.start.date) {
    const [startYear, startMonth, startDay] = event.start.date.split('-').map(Number)
    const [endYear, endMonth, endDay] = (event.end.date ?? event.start.date).split('-').map(Number)
    return {
      event,
      start: new Date(startYear, startMonth - 1, startDay),
      end: new Date(endYear, endMonth - 1, endDay),
      allDay: true,
    }
  }

  return { event, start: new Date(event.start.dateTime!), end: new Date(event.end.dateTime!), allDay: false }
}

function describeDue(due: string, now: Date) {
  const dueMoment = new Date(due)
  const dueDay = new Date(dueMoment.getUTCFullYear(), dueMoment.getUTCMonth(), dueMoment.getUTCDate())
  const daysAway = Math.round((dueDay.getTime() - startOfDay(now).getTime()) / 86400000)

  if (daysAway < 0) return { label: 'Overdue', overdue: true }
  if (daysAway === 0) return { label: 'Today', overdue: false }
  if (daysAway === 1) return { label: 'Tomorrow', overdue: false }
  return { label: formatDate(dueDay), overdue: false }
}

function describeWeather(code: number) {
  if (code === 0) return { icon: '☀️', label: 'Clear' }
  if (code <= 2) return { icon: '⛅', label: 'Partly cloudy' }
  if (code === 3) return { icon: '☁️', label: 'Cloudy' }
  if (code === 45 || code === 48) return { icon: '🌫️', label: 'Fog' }
  if (code >= 51 && code <= 57) return { icon: '🌦️', label: 'Drizzle' }
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { icon: '🌧️', label: 'Rain' }
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { icon: '❄️', label: 'Snow' }
  if (code >= 95) return { icon: '⛈️', label: 'Thunderstorm' }
  return { icon: '🌡️', label: '' }
}

async function googleFetch(url: string, accessToken: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })

  if (response.status === 401) throw new UnauthorizedError()
  if (!response.ok) throw new Error(`Google API responded ${response.status}`)
  return response
}

async function fetchEvents(accessToken: string): Promise<CalendarEvent[]> {
  const todayStart = startOfDay(new Date())
  const params = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    timeMin: todayStart.toISOString(),
    timeMax: addDays(todayStart, 2).toISOString(),
    maxResults: '50',
  })

  const response = await googleFetch(`${CALENDAR_EVENTS_URL}?${params}`, accessToken)
  const body: { items?: CalendarEvent[] } = await response.json()
  return body.items ?? []
}

async function fetchTasks(accessToken: string): Promise<TaskItem[]> {
  const response = await googleFetch(
    `${TASKS_URL}?showCompleted=false&showHidden=false&maxResults=100`,
    accessToken,
  )
  const body: { items?: TaskItem[] } = await response.json()
  return (body.items ?? []).filter(task => task.title?.trim())
}

async function fetchWeather(): Promise<WeatherNow> {
  const params = new URLSearchParams({
    latitude: String(MANCHESTER.latitude),
    longitude: String(MANCHESTER.longitude),
    current: 'temperature_2m,weather_code',
    timezone: 'Europe/London',
  })

  const response = await fetch(`${WEATHER_URL}?${params}`)
  if (!response.ok) throw new Error(`Open-Meteo responded ${response.status}`)
  const body = await response.json()
  return {
    temperature: Math.round(body.current.temperature_2m),
    weatherCode: body.current.weather_code,
  }
}

function readClientId(): string {
  const fromUrl = new URLSearchParams(window.location.search).get('clientId')
  if (fromUrl) {
    localStorage.setItem(CLIENT_ID_KEY, fromUrl.trim())
    window.history.replaceState(null, '', window.location.pathname)
  }
  return localStorage.getItem(CLIENT_ID_KEY) ?? ''
}

function readSavedSession(): Session {
  try {
    const raw = localStorage.getItem(TOKEN_KEY)
    if (!raw) return { status: 'signed-out' }

    const saved: StoredToken = JSON.parse(raw)
    if (saved.expiresAt - Date.now() > 60 * 1000) {
      return { status: 'ready', accessToken: saved.accessToken, expiresAt: saved.expiresAt }
    }
    return { status: 'expired' }
  } catch {
    return { status: 'signed-out' }
  }
}

interface ClientIdFormProps {
  initialValue: string
  submitLabel: string
  onSave: (clientId: string) => void
  onCancel?: () => void
  onSignOut?: () => void
}

function ClientIdForm({ initialValue, submitLabel, onSave, onCancel, onSignOut }: ClientIdFormProps) {
  const [value, setValue] = useState(initialValue)
  const [invalid, setInvalid] = useState(false)

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    const trimmed = value.trim()

    if (!trimmed.endsWith('.apps.googleusercontent.com')) {
      setInvalid(true)
      return
    }
    onSave(trimmed)
  }

  return (
    <form className="panel" onSubmit={handleSubmit}>
      <h2>Google OAuth Client ID</h2>
      <p className="hint">
        Web application client with <code>{window.location.origin}</code> added as an authorised
        JavaScript origin.
      </p>
      <input
        type="text"
        value={value}
        onChange={event => setValue(event.target.value)}
        placeholder="1234567890-abc123.apps.googleusercontent.com"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {invalid && (
        <p className="form-error">
          That doesn't look like a Web Client ID. It should end in .apps.googleusercontent.com
        </p>
      )}
      <div className="panel-actions">
        {onSignOut && (
          <button type="button" className="ghost-button" onClick={onSignOut}>
            Sign out
          </button>
        )}
        {onCancel && (
          <button type="button" className="ghost-button" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="primary-button">
          {submitLabel}
        </button>
      </div>
    </form>
  )
}

function AddTaskModal({
  onSubmit,
  onClose,
}: {
  onSubmit: (title: string) => Promise<void>
  onClose: () => void
}) {
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    const trimmed = title.trim()
    if (!trimmed || saving) return

    setSaving(true)
    setFailed(false)
    try {
      await onSubmit(trimmed)
    } catch {
      setFailed(true)
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="panel" onSubmit={handleSubmit}>
        <h2>New task</h2>
        <input
          autoFocus
          type="text"
          value={title}
          onChange={event => setTitle(event.target.value)}
          placeholder="What needs doing?"
        />
        {failed && <p className="form-error">Couldn't save that. Check the connection and try again.</p>}
        <div className="panel-actions">
          <button type="button" className="ghost-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={saving || !title.trim()}>
            {saving ? 'Adding…' : 'Add task'}
          </button>
        </div>
      </form>
    </div>
  )
}

function EventRow({ entry, now, tone }: { entry: ScheduleEntry; now: Date; tone: 'today' | 'tomorrow' }) {
  const { event, start, end, allDay } = entry
  const isFinished = !allDay && end <= now
  const isLive = !allDay && start <= now && now < end

  const classes = ['event-row', `is-${tone}`]
  if (isFinished) classes.push('is-finished')
  if (isLive) classes.push('is-live')

  return (
    <li className={classes.join(' ')}>
      <div className="event-time">
        {allDay ? (
          <span className="event-start">All day</span>
        ) : (
          <>
            <span className="event-start">{formatClock(start)}</span>
            <span className="event-end">{formatClock(end)}</span>
          </>
        )}
      </div>
      <div className="event-body">
        <span className="event-title">{cleanEventTitle(event.summary ?? '')}</span>
        {event.location && <span className="event-location">{event.location}</span>}
      </div>
    </li>
  )
}

function DaySection({
  title,
  tone,
  entries,
  now,
}: {
  title: string
  tone: 'today' | 'tomorrow'
  entries: ScheduleEntry[]
  now: Date
}) {
  return (
    <section>
      <h2 className={`day-heading is-${tone}`}>{title}</h2>
      {entries.length === 0 ? (
        <p className="empty-note">Nothing scheduled</p>
      ) : (
        <ul>
          {entries.map(entry => (
            <EventRow key={entry.event.id} entry={entry} now={now} tone={tone} />
          ))}
        </ul>
      )}
    </section>
  )
}

export default function App() {
  const [clientId, setClientId] = useState(readClientId)
  const [session, setSession] = useState<Session>(readSavedSession)
  const [now, setNow] = useState(() => new Date())
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [weather, setWeather] = useState<WeatherNow | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [syncFailed, setSyncFailed] = useState(false)
  const [googleReady, setGoogleReady] = useState(false)
  const [isAddingTask, setIsAddingTask] = useState(false)
  const [isEditingSettings, setIsEditingSettings] = useState(false)

  const tokenClientRef = useRef<TokenClient | null>(null)
  const completingTaskIds = useRef(new Set<string>())

  useEffect(() => {
    const tick = window.setInterval(() => {
      const current = new Date()
      setNow(previous => (previous.getMinutes() === current.getMinutes() ? previous : current))
    }, 1000)
    return () => window.clearInterval(tick)
  }, [])

  const expireSession = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY)
    setSession({ status: 'expired' })
  }, [])

  const handleTokenResponse = useCallback((response: TokenResponse) => {
    if (!response.access_token) return

    const expiresAt = Date.now() + (Number(response.expires_in) || 3600) * 1000
    const saved: StoredToken = { accessToken: response.access_token, expiresAt }
    localStorage.setItem(TOKEN_KEY, JSON.stringify(saved))
    setSession({ status: 'ready', accessToken: response.access_token, expiresAt })
  }, [])

  useEffect(() => {
    if (!clientId) return

    let retryTimer: number | undefined
    const createTokenClient = () => {
      if (!window.google) {
        retryTimer = window.setTimeout(createTokenClient, 500)
        return
      }
      tokenClientRef.current = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: GOOGLE_SCOPES,
        callback: handleTokenResponse,
        error_callback: error => console.warn('Google sign-in did not complete:', error.type),
      })
      setGoogleReady(true)
    }

    createTokenClient()
    return () => {
      window.clearTimeout(retryTimer)
      tokenClientRef.current = null
      setGoogleReady(false)
    }
  }, [clientId, handleTokenResponse])

  // try a quiet renewal just before the hour is up; if the popup gets blocked the 401 path takes over
  useEffect(() => {
    if (session.status !== 'ready' || !session.expiresAt) return

    const delay = Math.max(session.expiresAt - Date.now() - RENEW_BEFORE_EXPIRY_MS, 0)
    const renewTimer = window.setTimeout(() => {
      tokenClientRef.current?.requestAccessToken({ prompt: '' })
    }, delay)
    return () => window.clearTimeout(renewTimer)
  }, [session.status, session.expiresAt])

  const refreshAll = useCallback(async () => {
    setIsRefreshing(true)

    const weatherJob = fetchWeather()
      .then(setWeather)
      .catch(error => console.warn('Weather fetch failed:', error))

    const token = session.status === 'ready' ? session.accessToken : undefined
    const googleJob = token
      ? Promise.all([fetchEvents(token), fetchTasks(token)])
          .then(([freshEvents, freshTasks]) => {
            setEvents(freshEvents)
            setTasks(freshTasks.filter(task => !completingTaskIds.current.has(task.id)))
            setSyncFailed(false)
          })
          .catch(error => {
            if (error instanceof UnauthorizedError) expireSession()
            else setSyncFailed(true)
          })
      : Promise.resolve()

    await Promise.all([weatherJob, googleJob])
    setIsRefreshing(false)
  }, [session.status, session.accessToken, expireSession])

  const todayKey = startOfDay(now).getTime()

  useEffect(() => {
    refreshAll()
    const pollTimer = window.setInterval(refreshAll, POLL_INTERVAL_MS)
    return () => window.clearInterval(pollTimer)
  }, [refreshAll, todayKey])

  function connectGoogle() {
    tokenClientRef.current?.requestAccessToken({ prompt: '' })
  }

  function saveClientId(newClientId: string) {
    if (newClientId !== clientId) {
      localStorage.removeItem(TOKEN_KEY)
      setSession({ status: 'signed-out' })
    }
    localStorage.setItem(CLIENT_ID_KEY, newClientId)
    setClientId(newClientId)
    setIsEditingSettings(false)
  }

  function signOut() {
    localStorage.removeItem(TOKEN_KEY)
    setSession({ status: 'signed-out' })
    setEvents([])
    setTasks([])
    setIsEditingSettings(false)
  }

  async function completeTask(taskId: string) {
    if (!session.accessToken) return

    completingTaskIds.current.add(taskId)
    setTasks(current => current.filter(task => task.id !== taskId))

    try {
      await googleFetch(`${TASKS_URL}/${taskId}`, session.accessToken, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'completed' }),
      })
    } catch (error) {
      if (error instanceof UnauthorizedError) expireSession()
      else refreshAll()
    } finally {
      completingTaskIds.current.delete(taskId)
    }
  }

  async function addTask(title: string) {
    if (!session.accessToken) return

    try {
      const response = await googleFetch(TASKS_URL, session.accessToken, {
        method: 'POST',
        body: JSON.stringify({ title }),
      })
      const createdTask: TaskItem = await response.json()
      setTasks(current => [createdTask, ...current])
      setIsAddingTask(false)
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        setIsAddingTask(false)
        expireSession()
        return
      }
      throw error
    }
  }

  if (!clientId) {
    return (
      <div className="setup-screen">
        <ClientIdForm initialValue="" submitLabel="Save and continue" onSave={saveClientId} />
      </div>
    )
  }

  const tomorrowStart = addDays(startOfDay(now), 1)
  const todayEntries: ScheduleEntry[] = []
  const tomorrowEntries: ScheduleEntry[] = []
  for (const event of events) {
    const entry = toScheduleEntry(event)
    if (entry.start < tomorrowStart) todayEntries.push(entry)
    else tomorrowEntries.push(entry)
  }

  const weatherNow = weather ? describeWeather(weather.weatherCode) : null

  return (
    <div className="planner">
      <header className="topbar">
        <span className="clock">{formatClock(now)}</span>
        <span className="date">{formatDate(now)}</span>
        <span className="weather">
          {weather && weatherNow ? `${weatherNow.icon} ${weather.temperature}° ${weatherNow.label}` : '--'}
        </span>

        <div className="topbar-actions">
          {syncFailed && <span className="sync-warning">Sync failed</span>}
          <button type="button" className="icon-button" aria-label="Refresh" onClick={refreshAll}>
            <svg viewBox="0 0 24 24" className={isRefreshing ? 'spinning' : ''}>
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Settings"
            onClick={() => setIsEditingSettings(true)}
          >
            <svg viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="6.5" strokeWidth="2.5" />
              <circle cx="12" cy="12" r="9.5" strokeWidth="3" strokeDasharray="3.73 3.73" />
            </svg>
          </button>
        </div>
      </header>

      {session.status === 'ready' ? (
        <main className="columns">
          <section className="column">
            <div className="scroll-area">
              <DaySection title="Today" tone="today" entries={todayEntries} now={now} />
              <DaySection title="Tomorrow" tone="tomorrow" entries={tomorrowEntries} now={now} />
            </div>
          </section>

          <section className="column tasks-column">
            <div className="column-header">
              <h2>Tasks</h2>
              <span className="task-count">{tasks.length}</span>
              <button
                type="button"
                className="icon-button add-button"
                aria-label="Add task"
                onClick={() => setIsAddingTask(true)}
              >
                <svg viewBox="0 0 24 24">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            </div>

            {tasks.length === 0 ? (
              <p className="empty-note">All clear</p>
            ) : (
              <ul className="scroll-area">
                {tasks.map(task => {
                  const due = task.due ? describeDue(task.due, now) : null
                  return (
                    <li key={task.id}>
                      <button type="button" className="task-row" onClick={() => completeTask(task.id)}>
                        <span className="task-ring" />
                        <span className="task-text">
                          <span className="task-title">{task.title}</span>
                          {due && (
                            <span className={due.overdue ? 'task-due is-overdue' : 'task-due'}>
                              {due.label}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </main>
      ) : (
        <main className="reconnect">
          <button type="button" className="reconnect-button" onClick={connectGoogle} disabled={!googleReady}>
            {!googleReady
              ? 'Loading Google…'
              : session.status === 'expired'
                ? 'Session Expired — Tap to Reconnect'
                : 'Connect Google Calendar & Tasks'}
          </button>
        </main>
      )}

      {isAddingTask && <AddTaskModal onSubmit={addTask} onClose={() => setIsAddingTask(false)} />}

      {isEditingSettings && (
        <div className="modal-backdrop">
          <ClientIdForm
            initialValue={clientId}
            submitLabel="Save"
            onSave={saveClientId}
            onCancel={() => setIsEditingSettings(false)}
            onSignOut={signOut}
          />
        </div>
      )}
    </div>
  )
}
