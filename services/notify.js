// Notification V2 producer: builds the business event and hands it to the DB
// function notify_event() (aivorah-db 0006), which fans out to the student +
// linked parents idempotently. Never throws — the assignment is already saved.
const supabase = require('./supabase');

function logEvent(fields) {
  console.log(JSON.stringify({ svc: 'challenges', ...fields }));
}

function formatDue(dueDate) {
  if (!dueDate) return null;
  const d = new Date(String(dueDate).includes('T') ? dueDate : `${dueDate}T00:00:00Z`);
  return Number.isFinite(d.getTime())
    ? d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    : null;
}

// Version = assigned_at, which the route bumps on a completed→re-assign, so a
// real re-assignment is a new event while retries of the same one are not.
function challengeAssignedEvent({ challenge, assignment, actorEmail, actorRole }) {
  const due = formatDue(assignment.due_date);
  const body = [challenge.subject || null, due ? `Due ${due}` : null].filter(Boolean).join(' · ') || null;
  const email = String(actorEmail || '').trim().toLowerCase();
  return {
    type: 'challenge_assigned',
    entity_type: 'challenge_assignment',
    entity_id: String(assignment.id),
    version: assignment.assigned_at || assignment.created_at,
    student_ids: [assignment.student_id],
    actor_email: email.includes('@') ? email : null,
    actor_role: actorRole || null,
    title: `New challenge: ${challenge.title}`,
    body,
    parent_title: `New challenge for {child}: ${challenge.title}`,
    parent_body: body,
    data: {
      challengeId: String(challenge.id),
      challengeAssignmentId: String(assignment.id),
      subject: challenge.subject || null,
      dueDate: assignment.due_date || null,
    },
  };
}

async function createNotificationEvent(evt) {
  const base = { evt: 'notification.create', type: evt.type, entityType: evt.entity_type, entity: evt.entity_id };
  try {
    const { data, error } = await supabase.rpc('notify_event', { p_event: evt });
    if (error) throw new Error(error.message);
    const inserted = data?.inserted ?? [];
    logEvent({
      ...base, ok: true, eventKey: data?.eventKey, recipients: data?.recipients ?? 0,
      inserted: inserted.length, duplicates: data?.duplicates ?? 0,
      orphanParentLinks: data?.orphanParentLinks ?? 0, notificationIds: inserted.map(r => r.id),
    });
    return { ok: true, inserted, recipients: data?.recipients ?? 0, duplicates: data?.duplicates ?? 0 };
  } catch (err) {
    logEvent({ ...base, ok: false, reason: err.message });
    return { ok: false, error: err.message };
  }
}

// Clears (marks read) the still-open notifications for this entity once they're stale:
// the student's own row and their parents' rows about that child. Never throws.
async function clearNotificationsForEntity({ entityId, studentId, reason }) {
  const base = { evt: 'notification.clear', entityType: 'challenge_assignment', entity: String(entityId), reason };
  try {
    let q = supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('entity_type', 'challenge_assignment')
      .eq('entity_id', String(entityId))
      .is('read_at', null);
    if (studentId) q = q.or(`recipient_id.eq.${studentId},child_id.eq.${studentId}`);
    const { data, error } = await q.select('id');
    if (error) throw new Error(error.message);
    logEvent({ ...base, ok: true, cleared: (data || []).length });
    return { ok: true, cleared: (data || []).length };
  } catch (err) {
    logEvent({ ...base, ok: false, reason: err.message });
    return { ok: false, error: err.message };
  }
}

module.exports = { challengeAssignedEvent, createNotificationEvent, clearNotificationsForEntity, formatDue };
