import type { Appointment } from './performance-store.js';

/**
 * Minimal confirm-then-write appointments.
 * The historical src/appointments module is not in this repository.
 */

export interface AppointmentRequest { customer: string; whenText: string; note: string; }

export function parseAppointmentUtterance(text: string): AppointmentRequest | null {
  const match = text.trim().match(/^预约\s+(\S+)\s+(.+)$/);
  if (!match || match[1] === undefined || match[2] === undefined) return null;
  const time = /(\d{1,2})[:：](\d{2})/.exec(match[2]);
  if (!time || time.index === undefined) return null;
  const hour = Number(time[1]);
  const minute = Number(time[2]);
  if (hour > 23 || minute > 59) return null;
  const whenText = match[2].slice(0, time.index + time[0].length).trim();
  const note = match[2].slice(time.index + time[0].length).trim();
  if (!whenText) return null;
  return { customer: match[1], whenText, note };
}

export function validateAppointmentFields(value: unknown): { ok: true; item: AppointmentRequest } | { ok: false } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !['customer', 'whenText', 'note'].includes(key))) return { ok: false };
  if (typeof body.customer !== 'string' || !body.customer.trim()) return { ok: false };
  if (typeof body.whenText !== 'string' || !/(\d{1,2})[:：](\d{2})/.test(body.whenText)) return { ok: false };
  if (body.note !== undefined && typeof body.note !== 'string') return { ok: false };
  return { ok: true, item: { customer: body.customer.trim(), whenText: body.whenText.trim(), note: typeof body.note === 'string' ? body.note.trim() : '' } };
}

export function stagePendingAppointment(input: AppointmentRequest & {
  appointmentId: string; storeId: string; employeePersonId: string; createdAt: string;
}): Appointment {
  return {
    appointmentId: input.appointmentId,
    storeId: input.storeId,
    employeePersonId: input.employeePersonId,
    customerName: input.customer,
    whenText: input.whenText,
    note: input.note,
    status: 'pending_manager',
    createdAt: input.createdAt,
  };
}

export function confirmAppointment(appointment: Appointment): Appointment {
  if (appointment.status !== 'pending_manager') throw Error('appointment_not_pending');
  return { ...appointment, status: 'confirmed' };
}
