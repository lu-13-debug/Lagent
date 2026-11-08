import { randomUUID } from 'node:crypto';

export const WORK_EVENT_LIMITS = Object.freeze({ perTicket: 500, total: 5000 });

export function pruneWorkEvents(store) {
  const perTicket = new Map();
  let retained = 0;
  // list() is newest-first; delete from the transaction after dropping the oldest excess rows.
  for (const event of store.list('work-event')) {
    const ticketCount = perTicket.get(event.ticketId) || 0;
    if (retained >= WORK_EVENT_LIMITS.total || ticketCount >= WORK_EVENT_LIMITS.perTicket) {
      store.delete('work-event', event.id);
      continue;
    }
    perTicket.set(event.ticketId, ticketCount + 1);
    retained++;
  }
}

export function appendWorkEvent(store, type, payload) {
  const event = {
    id: randomUUID(),
    type,
    ticketId: type === 'ticket' ? payload.id : payload.ticketId,
    payload,
    createdAt: new Date().toISOString()
  };
  store.put('work-event', event);
  return event;
}

export function workStore(store, publish) {
  const api = {
    get:(kind,id)=>store.get(`work-${kind}`,id),
    list:kind=>store.list(`work-${kind}`),
    put:(kind,payload)=>{store.put(`work-${kind}`,payload);return payload;},
    delete:(kind,id)=>store.delete(`work-${kind}`,id),
    transaction(fn) {
      const events = [];
      const transaction = {
        get:(kind,id)=>store.get(`work-${kind}`,id),
        list:kind=>store.list(`work-${kind}`),
        put(kind,payload) { store.put(`work-${kind}`,payload); return payload; },
        delete:(kind,id)=>store.delete(`work-${kind}`,id),
        event(type,payload) {
          const event = appendWorkEvent(store, type, payload);
          events.push(event);
          return event;
        }
      };
      const result = store.atomic(() => {
        const outcome = fn(transaction);
        pruneWorkEvents(store);
        return outcome;
      });
      events.forEach(publish);
      return result;
    },
    write(entries, control) {
      return api.transaction(transaction => {
        if (control) transaction.put('control', control);
        for (const [type, payload] of entries) {
          transaction.put(type, payload);
          transaction.event(type, payload);
        }
      });
    }
  };
  return api;
}
