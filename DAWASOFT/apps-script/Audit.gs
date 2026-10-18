/**
 * Audit.gs — append-only audit trail (Observability / Postmortems from the checklist).
 * Never throws: auditing must not break the business operation it is recording.
 */

function writeAudit(actor, action, entity, entityId, result, details) {
  try {
    appendObject('Audit Log', unpick(FIELDS.audit, {
      timestamp: nowIso(),
      actorId: actor ? actor.id || actor.userId || '' : '',
      actorUsername: actor ? actor.username || '' : 'anonymous',
      action: action || '',
      entity: entity || '',
      entityId: entityId === undefined || entityId === null ? '' : String(entityId),
      result: result || 'success',
      details: details ? JSON.stringify(details) : ''
    }));
  } catch (e) {
    Logger.log('audit failed: ' + e);
  }
}
