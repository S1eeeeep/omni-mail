import { MAIL_SOURCE_IDS, type MailSourceId } from './mail-source'

export const NOTIFICATION_SOURCE_IDS: MailSourceId[] = [...MAIL_SOURCE_IDS]

export interface NotificationSettings {
  notificationsEnabled: boolean
  notificationSources: MailSourceId[]
  quietHoursEnabled: boolean
  quietHoursStart: string
  quietHoursEnd: string
}

export const DEFAULT_QUIET_HOURS_START = '22:00'
export const DEFAULT_QUIET_HOURS_END = '07:00'

function validTime(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
}

export function normalizedNotificationSettings(
  value: Partial<NotificationSettings>,
): NotificationSettings {
  const sources = Array.isArray(value.notificationSources)
    ? value.notificationSources.filter((source): source is MailSourceId => (
        NOTIFICATION_SOURCE_IDS.includes(source as MailSourceId)
      ))
    : NOTIFICATION_SOURCE_IDS
  return {
    notificationsEnabled: value.notificationsEnabled !== false,
    notificationSources: [...new Set(sources)],
    quietHoursEnabled: value.quietHoursEnabled === true,
    quietHoursStart: validTime(value.quietHoursStart)
      ? value.quietHoursStart : DEFAULT_QUIET_HOURS_START,
    quietHoursEnd: validTime(value.quietHoursEnd)
      ? value.quietHoursEnd : DEFAULT_QUIET_HOURS_END,
  }
}

function minuteOfDay(value: string): number {
  const [hour, minute] = value.split(':').map(Number)
  return hour * 60 + minute
}

export function isQuietTime(
  settings: NotificationSettings,
  date = new Date(),
): boolean {
  if (!settings.quietHoursEnabled || !settings.quietHoursStart || !settings.quietHoursEnd) return false
  const start = minuteOfDay(settings.quietHoursStart)
  const end = minuteOfDay(settings.quietHoursEnd)
  const current = date.getHours() * 60 + date.getMinutes()
  if (start === end) return false
  return start < end
    ? current >= start && current < end
    : current >= start || current < end
}
