import { describe, it, expect } from 'vitest';
import { roleLabel, isOfficeLevel, ASSIGNABLE_ROLES } from './roles';

describe('roles', () => {
  it('names the three levels', () => {
    expect(roleLabel('owner')).toBe('Main Admin');
    expect(roleLabel('office')).toBe('Office Admin');
    expect(roleLabel('salesman')).toBe('Sales');
    expect(roleLabel(undefined)).toBe('');
  });
  it('treats the main admin as office-level, sales as not', () => {
    expect(isOfficeLevel('owner')).toBe(true);
    expect(isOfficeLevel('office')).toBe(true);
    expect(isOfficeLevel('salesman')).toBe(false);
  });
  it('never offers the main admin level to be handed out', () => {
    expect(ASSIGNABLE_ROLES).toEqual(['office', 'salesman']);
  });
});
