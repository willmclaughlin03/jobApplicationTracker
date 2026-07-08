const { createSuccessResponse, sendSuccess } = require('../response.js');

describe('response success helpers', () => {
  it('merges optional metadata into success responses without overriding canonical fields', () => {
    const response = createSuccessResponse(
      { id: 'job-1' },
      'Created',
      {
        storageSummary: { activeCount: 1 },
        data: 'ignored-data',
        error: 'ignored-error',
        message: 'ignored-message',
      }
    );

    expect(response).toEqual({
      data: { id: 'job-1' },
      error: null,
      message: 'Created',
      storageSummary: { activeCount: 1 },
    });
  });

  it('sends metadata through the shared success response helper', () => {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    sendSuccess(res, 201, [{ id: 'job-1' }], 'Created', {
      storageSummary: { activeCount: 1 },
    });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({
      data: [{ id: 'job-1' }],
      error: null,
      message: 'Created',
      storageSummary: { activeCount: 1 },
    });
  });
});