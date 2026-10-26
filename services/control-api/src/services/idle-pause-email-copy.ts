export type IdlePauseEmailTemplate = 'project_idle_warning' | 'project_idle_reminder' | 'project_paused_idle';

/** One copy source for HTML, plain text and subject lines. Grace is internal. */
export function idlePauseEmailCopy(template: IdlePauseEmailTemplate, data: Record<string, string>) {
  const name = data.appName || data.appId || 'Your project';
  const lead = data.warnDays || (template === 'project_idle_reminder' ? '3' : '7');
  const dashboard = process.env.DASHBOARD_URL || 'https://dashboard.butterbase.ai';
  const billingUrl = data.organizationId
    ? `${dashboard}/organizations/${encodeURIComponent(data.organizationId)}/billing`
    : `${dashboard}/billing`;
  const appUrl = `${dashboard}/apps/${encodeURIComponent(data.appId || '')}`;
  if (template === 'project_paused_idle') return {
    subject: `${name} has been paused`,
    paragraphs: [
      `Your free project, ${name}, has been paused because it was inactive.`,
      'Your data has not been deleted. Upgrade to a paid plan to resume your project.',
      'Projects on paid plans do not pause for inactivity.',
    ], button: 'Upgrade to resume', billingUrl, appUrl,
  };
  if (template === 'project_idle_reminder') return {
    subject: `Reminder: ${name} pauses in ${lead} days`,
    paragraphs: [
      `Your free project, ${name}, is still inactive and is scheduled to pause in ${lead} days.`,
      'If you still need it, use your app and bring real traffic to it, or upgrade to a paid plan to keep it running. Scheduled Butterbase cron jobs do not count as activity.',
      'If you no longer need this project, no action is required. Your data will be retained. Once a project is paused for inactivity, upgrading is required to resume it.',
    ], button: 'Upgrade your plan', billingUrl, appUrl,
  };
  return {
    subject: `${name} will pause in ${lead} days`,
    paragraphs: [
      `Your free project, ${name}, has been inactive${data.inactiveDays ? ` for ${data.inactiveDays} days` : ''}. It will pause in ${lead} days if there is no new activity.`,
      'To keep it running, use your app and bring real traffic to it, or upgrade to a paid plan. Scheduled Butterbase cron jobs do not count as activity.',
      'If you no longer need this project, no action is required. Pausing does not delete your data. Once a project is paused for inactivity, upgrading is required to resume it.',
    ], button: 'Upgrade your plan', billingUrl, appUrl,
  };
}
