// What the ServerKit app contains, at screen level, so the analyst can talk
// about features instead of raw event names. Each screen is [source file stem,
// what the user sees]; `parts` are sub-views of a screen above. Keep this in
// step with lib/features when a screen is added.
export const APP_FEATURES = [
  {
    name: 'Servers and connections',
    screens: [['servers_screen', 'home with tabs SSH, Labs, Database, Docker, Kubernetes, Cloud'], ['server_form_page', 'add or edit a server'], ['server_dashboard_screen', 'per-server hub with a grid of tools']],
    signals: 'server_added, server_updated, server_connected, connection_error, server_add_entry_point, empty_state_shown'
  },
  {
    name: 'SSH terminal',
    screens: [['terminal_page', 'full shell with snippets, gestures, mosh and an AI helper sheet']],
    signals: 'terminal_opened, terminal_command_sent, terminal_reconnected, terminal_snippet_*'
  },
  {
    name: 'Web terminal',
    screens: [['web_terminal_page', 'opens the terminal in a desktop browser through a local server']],
    signals: 'web_terminal_*'
  },
  {
    name: 'File manager and disk analyzer',
    screens: [['file_manager_page', 'browse, upload, download, rename, chmod'], ['file_editor_page', 'edit a text file'], ['disk_analyzer_page', 'find what is using disk space']],
    parts: ['disk_analyzer_page_dir_list_view', 'disk_analyzer_page_disk_analyzer_view'],
    signals: 'file_manager_*, disk_analyzer_opened'
  },
  {
    name: 'Local file server (a Labs tool)',
    screens: [['local_file_server_page', 'hub to share phone files'], ['local_http_server_page', 'share over HTTP'], ['local_ftp_server_page', 'share over FTP'], ['local_webdav_server_page', 'share over WebDAV'], ['local_file_server_help_page', 'help']],
    signals: 'file_server_*, webdav_upgrade_tapped'
  },
  {
    name: 'Labs (on-device Linux VM and tools)',
    screens: [['labs_tab_ready_view', 'VM ready view with boot, snapshot and stop'], ['uptime_monitor_page', 'Uptime Monitor tool, checks that a site or port is up'], ['dns_toolbox_page', 'DNS Toolbox'], ['network_calculator_page', 'Network Calculator'], ['port_checker_page', 'Port Checker'], ['tls_inspector_page', 'TLS Inspector'], ['traceroute_page', 'Traceroute'], ['topology_result_page', 'network topology result']],
    signals: 'lab_opened, lab_boot, lab_provisioned, lab_snapshot, lab_vm_stopped, lab_tool_opened (tool_name), uptime_*'
  },
  {
    name: 'Server stats and monitoring alerts',
    screens: [['server_stats_page', 'live CPU, RAM, disk and network, history, lifetime peaks, alerts sheet'], ['monitoring_page', 'alert rules and alert history'], ['pulse_landing_page', 'daily health pulse landing']],
    signals: 'feature_open server_stats or monitoring or monitor_agent, notification_*'
  },
  {
    name: 'Background monitoring agent',
    screens: [],
    note: 'a setup sheet that installs a small script on the server so alerts reach the phone while the app is closed',
    signals: 'feature_action monitor_agent'
  },
  {
    name: 'Docker',
    screens: [['docker_page', 'containers and images'], ['docker_dashboard_screen', 'Docker tab dashboard'], ['container_detail_screen', 'one container'], ['docker_logs_page', 'container logs']],
    signals: 'feature_open docker'
  },
  {
    name: 'Kubernetes',
    screens: [['kubernetes_dashboard_screen', 'cluster dashboard'], ['deployment_pods_screen', 'pods of a deployment'], ['pod_detail_screen', 'one pod'], ['kubernetes_logs_page', 'pod logs'], ['kubernetes_stats_page', 'cluster stats'], ['secret_detail_page', 'view a secret'], ['secret_editor_page', 'edit a secret']],
    signals: 'kube_*'
  },
  {
    name: 'Databases (MySQL and Postgres)',
    screens: [['rdbms_dashboard_screen', 'connections and SQL'], ['databases_tab_table_list_screen', 'tables of a database'], ['databases_tab_table_detail_screen', 'one table']],
    signals: 'feature_open rdbms'
  },
  {
    name: 'AWS cloud',
    screens: [['aws_dashboard_screen', 'AWS home'], ['add_aws_account_sheet_step_page', 'connect an AWS account'], ['ec2_instances_screen', 'EC2'], ['ecs_screen', 'ECS'], ['eks_screen', 'EKS'], ['eks_cluster_detail_screen', 'one EKS cluster'], ['lambda_screen', 'Lambda'], ['lambda_function_detail_screen', 'one function'], ['rds_screen', 'RDS'], ['rds_instance_detail_screen', 'one RDS instance'], ['s3_screen', 'S3'], ['s3_browser_screen', 'browse a bucket'], ['cloudwatch_screen', 'CloudWatch'], ['log_viewer_screen', 'log viewer']],
    signals: 'feature_open aws'
  },
  {
    name: 'System services (systemctl) and PM2',
    screens: [['systemctl_page', 'start, stop and inspect systemd services'], ['pm2_page', 'manage PM2 processes']],
    signals: 'feature_open systemctl or pm2'
  },
  {
    name: 'Software installers',
    screens: [['nginx_page', 'Nginx'], ['apache2_page', 'Apache'], ['web_server_page', 'web server setup'], ['mysql_page', 'MySQL'], ['postgres_page', 'PostgreSQL'], ['mongo_page', 'MongoDB'], ['redis_page', 'Redis']],
    signals: 'software_opened, feature_open softwares'
  },
  {
    name: 'APT package store',
    screens: [['apt_store_page', 'search and install packages']],
    signals: 'apt_*'
  },
  {
    name: 'SSL certificates',
    screens: [['certbot_page', 'issue and renew Let\'s Encrypt certificates']],
    signals: 'ssl_*'
  },
  {
    name: 'Firewall',
    screens: [['firewall_page', 'view and edit firewall rules']],
    parts: ['firewall_page_firewall_view'],
    signals: 'feature_open firewall'
  },
  {
    name: 'Users, keys and identities',
    screens: [['users_page', 'Linux users and SSH keys on the server'], ['identities_page', 'saved logins and keys inside the app']],
    signals: 'identity_*'
  },
  {
    name: 'Environment variables',
    screens: [['env_manager_page', 'view and edit environment variables']],
    signals: 'env_*'
  },
  {
    name: 'Task manager',
    screens: [['task_manager_page', 'running processes, kill a process']],
    signals: 'task_manager_*'
  },
  {
    name: 'Backups',
    screens: [['backup_page', 'backup jobs (two entry screens)'], ['new_backup_page', 'create a backup job'], ['backup_job_detail_page', 'one job'], ['backup_restore_page', 'restore']],
    signals: 'feature_open backup'
  },
  {
    name: 'AI assistant',
    screens: [],
    note: 'a chat sheet that helps with a command inside the terminal, plus its settings section',
    signals: 'terminal_ai_sheet_opened'
  },
  {
    name: 'AI agent',
    screens: [['agent_page', 'agent that plans and runs commands for the user'], ['agent_paywall_page', 'paywall for the agent']],
    parts: ['agent_page_agent_view'],
    signals: 'agent_*, cli_*'
  },
  {
    name: 'MCP hub',
    screens: [['mcp_hub_page', 'lets AI tools on a desktop use the phone\'s servers'], ['mcp_server_running_view', 'running server'], ['mcp_command_log_view', 'command log']],
    signals: 'mcp_*'
  },
  {
    name: 'Settings and purchases',
    screens: [['settings_page', 'settings home'], ['language_page', 'language'], ['download_settings_page', 'download location'], ['subscription_page', 'subscription and remove-ads purchase']],
    signals: 'purchase_*, theme_changed'
  },
  {
    name: 'Onboarding',
    screens: [['onboarding_screen', 'intro pages and the final Get Started page with two questions'], ['terms_acceptance_screen', 'terms and privacy']],
    parts: ['onboarding_screen_onboarding_page_view', 'onboarding_screen_survey_page'],
    signals: 'onboarding_*, terms_*, notification_permission_result'
  }
]

export function featureMapText() {
  const lines = APP_FEATURES.map(f => {
    const where = f.screens.length ? f.screens.map(([, label]) => label).join('; ') : f.note
    return `- ${f.name}: ${where}. Events: ${f.signals}.`
  })
  return `APP FEATURE MAP (every screen the user can open)\nMain tabs: SSH, Labs, Database, Docker, Kubernetes, Cloud.\n${lines.join('\n')}`
}

export const allScreenFiles = () => APP_FEATURES.flatMap(f => [...f.screens.map(([file]) => file), ...(f.parts ?? [])])
