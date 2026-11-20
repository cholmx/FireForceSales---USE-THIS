// Access levels. DB values stay owner / office / salesman; these are the names people see.
export const ROLE_LABELS = { owner: 'Main Admin', office: 'Office Admin', salesman: 'Sales' };
// What the main admin can hand out to other people
export const ASSIGNABLE_ROLES = ['office', 'salesman'];
export const roleLabel = (role) => ROLE_LABELS[role] || role || '';
// The main admin has all office powers; "office-level" covers both
export const isOfficeLevel = (role) => role === 'owner' || role === 'office';
