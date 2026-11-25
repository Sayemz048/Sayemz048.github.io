export interface CalendarEvent {
  id: string
  summary?: string
  location?: string
  start: { dateTime?: string; date?: string }
  end: { dateTime?: string; date?: string }
}

export interface ScheduleEntry {
  event: CalendarEvent
  start: Date
  end: Date
  allDay: boolean
}

export interface TaskItem {
  id: string
  title: string
  due?: string
}

export interface WeatherNow {
  temperature: number
  weatherCode: number
}

export type AuthStatus = 'signed-out' | 'expired' | 'ready'

export interface Session {
  status: AuthStatus
  accessToken?: string
  expiresAt?: number
}

export interface StoredToken {
  accessToken: string
  expiresAt: number
}

export interface TokenResponse {
  access_token?: string
  expires_in?: string | number
  error?: string
}

export interface TokenClient {
  requestAccessToken(options?: { prompt?: string }): void
}

interface TokenClientConfig {
  client_id: string
  scope: string
  callback: (response: TokenResponse) => void
  error_callback?: (error: { type: string }) => void
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(config: TokenClientConfig): TokenClient
        }
      }
    }
  }
}
