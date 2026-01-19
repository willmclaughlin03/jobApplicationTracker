import { useState, useCallback, useMemo } from 'react';

const DEFAULT_PAGE_SIZE = 10;

export function usePagination(pageSize = DEFAULT_PAGE_SIZE) {
  const [currentPage, setCurrentPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);

  const totalPages = useMemo(() =>
    Math.ceil(totalCount / pageSize),
    [totalCount, pageSize]
  );

  const hasNextPage = useMemo(() =>
    currentPage < totalPages,
    [currentPage, totalPages]
  );

  const hasPrevPage = useMemo(() =>
    currentPage > 1,
    [currentPage]
  );

  const goToPage = useCallback((page) => {
    const validPage = Math.max(1, Math.min(page, totalPages || 1));
    setCurrentPage(validPage);
    return validPage;
  }, [totalPages]);

  const nextPage = useCallback(() => {
    if (hasNextPage) {
      return goToPage(currentPage + 1);
    }
    return currentPage;
  }, [hasNextPage, currentPage, goToPage]);

  const prevPage = useCallback(() => {
    if (hasPrevPage) {
      return goToPage(currentPage - 1);
    }
    return currentPage;
  }, [hasPrevPage, currentPage, goToPage]);

  const resetPagination = useCallback(() => {
    setCurrentPage(1);
    setTotalCount(0);
  }, []);

  const getRange = useCallback(() => {
    const from = (currentPage - 1) * pageSize;
    const to = from + pageSize - 1;
    return { from, to };
  }, [currentPage, pageSize]);

  return {
    currentPage,
    setCurrentPage,
    totalCount,
    setTotalCount,
    totalPages,
    hasNextPage,
    hasPrevPage,
    goToPage,
    nextPage,
    prevPage,
    resetPagination,
    getRange,
    pageSize,
  };
}
