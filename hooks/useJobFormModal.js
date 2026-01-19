import { useState, useCallback } from 'react';

export function useJobFormModal() {
  const [showForm, setShowForm] = useState(false);
  const [editingJob, setEditingJob] = useState(null);

  const openAddForm = useCallback(() => {
    setShowForm(true);
    setEditingJob(null);
  }, []);

  const openEditForm = useCallback((job) => {
    setEditingJob(job);
    setShowForm(false);
  }, []);

  const closeForm = useCallback(() => {
    setShowForm(false);
    setEditingJob(null);
  }, []);

  const closeAddForm = useCallback(() => {
    setShowForm(false);
  }, []);

  const closeEditForm = useCallback(() => {
    setEditingJob(null);
  }, []);

  const toggleAddForm = useCallback(() => {
    setShowForm(prev => !prev);
  }, []);

  return {
    showForm,
    editingJob,
    openAddForm,
    openEditForm,
    closeForm,
    closeAddForm,
    closeEditForm,
    toggleAddForm,
    setShowForm,
    setEditingJob,
  };
}
