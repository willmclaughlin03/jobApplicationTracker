export default function NextPageButton({ currentPage, totalCount, pageSize, onPageChange }) {
    const totalPages = Math.ceil(totalCount / pageSize);

    if (totalPages <= 1) {
        return null;
    }

    const getVisiblePages = () => {
        const maxButtons = 5;

        if (totalPages <= maxButtons) {
            return Array.from({ length: totalPages }, (_, i) => i + 1);
        }

        let start = Math.max(1, currentPage - 2);
        let end = Math.min(totalPages, start + maxButtons - 1);

        if (end - start < maxButtons - 1) {
            start = Math.max(1, end - maxButtons + 1);
        }

        return Array.from({ length: end - start + 1 }, (_, i) => start + i);
    };

    const visiblePages = getVisiblePages();

    return (
        <div className="flex gap-2 justify-center mt-4">
            {currentPage > 1 && (
                <button
                    onClick={() => onPageChange(currentPage - 1)}
                    className="px-3 py-1 border border-gray-300 rounded bg-white hover:bg-gray-100 cursor-pointer"
                >
                    Prev
                </button>
            )}

            {visiblePages.map((page) => (
                <button
                    key={page}
                    onClick={() => onPageChange(page)}
                    className={`px-3 py-1 border border-gray-300 rounded cursor-pointer ${
                        page === currentPage
                            ? 'bg-blue-500 text-white font-bold'
                            : 'bg-white text-black hover:bg-gray-100'
                    }`}
                >
                    {page}
                </button>
            ))}

            {currentPage < totalPages && (
                <button
                    onClick={() => onPageChange(currentPage + 1)}
                    className="px-3 py-1 border border-gray-300 rounded bg-white hover:bg-gray-100 cursor-pointer"
                >
                    Next
                </button>
            )}
        </div>
    );
}