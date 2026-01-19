export const STATUS_OPTIONS = [
  { value: 'applied', label: 'Applied' },
  { value: 'interviewing', label: 'Interviewing' },
  { value: 'offered', label: 'Offered' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'accepted', label: 'Accepted' },
];

export const STATUS_COLORS = {
  applied: 'bg-blue-100 text-blue-800',
  interviewing: 'bg-orange-100 text-orange-800',
  offered: 'bg-green-100 text-green-800',
  rejected: 'bg-red-100 text-red-800',
  accepted: 'bg-green-200 text-green-900',
};

export const INITIAL_FORM_DATA = {
  company: '',
  position: '',
  status: 'applied',
  notes: '',
};
