// Features the app is known to have, so "not used at all" can be reported.
export const KNOWN_FEATURES = [
  'terminal', 'web_terminal', 'file_manager', 'file_server', 'labs', 'uptime_monitor',
  'systemctl', 'pm2', 'docker', 'kubernetes', 'rdbms', 'ssl', 'apt_store', 'softwares',
  'monitoring', 'env_manager', 'task_manager', 'disk_analyzer', 'ai_assistant', 'ai_agent',
  'aws', 'server_stats', 'monitor_agent', 'backup', 'server_settings', 'quick_access'
]

// Event name prefix to feature, for events that are not feature_open/feature_action.
export const FEATURE_PREFIXES = [
  ['web_terminal_', 'web_terminal'], ['terminal_', 'terminal'], ['mosh_', 'terminal'],
  ['file_manager_', 'file_manager'], ['file_server_', 'file_server'], ['kube_', 'kubernetes'],
  ['lab_', 'labs'], ['agent_', 'ai_agent'], ['ssl_', 'ssl'], ['apt_', 'apt_store'],
  ['task_manager_', 'task_manager'], ['env_manager_', 'env_manager'],
  ['disk_analyzer_', 'disk_analyzer'], ['software_', 'softwares'], ['uptime_', 'uptime_monitor']
]

// Expected background noise. Hidden from the top-events list and never called
// a problem unless the spike detector flags a spike in them.
export const NOISY_EVENTS = new Set([
  'connection_error', 'user_engagement', 'screen_view', 'session_start', 'first_open',
  'app_remove', 'tab_open', 'empty_state_shown', 'onboarding_page_view',
  'notification_receive', 'notification_dismiss', 'notification_foreground',
  'notification_open', 'app_update', 'os_update', 'app_clear_data', 'firebase_campaign'
])

// A fall in these is worth reporting; a rise is not.
export const KEY_EVENTS = ['first_open', 'session_start', 'server_connected', 'server_added', 'onboarding_completed']

export const FUNNEL_STEPS = [
  'first_open', 'onboarding_started', 'onboarding_completed', 'server_added',
  'server_connected', 'terminal_opened', 'purchase_sheet_shown'
]

const INTERNAL_PARAMS = new Set([
  'engaged_session_event', 'debug_event', 'engagement_time_msec', 'entrances', 'session_engaged',
  'system_app', 'system_app_update', 'update_with_analytics', 'previous_first_open_count',
  'campaign_info_source', 'medium'
])

export function isTrackedParam(key) {
  return !key.startsWith('ga_') && !key.startsWith('firebase_') && !key.startsWith('previous_') && !INTERNAL_PARAMS.has(key)
}
