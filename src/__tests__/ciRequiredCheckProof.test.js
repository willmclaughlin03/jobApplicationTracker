/**
 * Deliberately fail the temporary Chunk 07d merge-gate proof.
 *
 * This callback takes no inputs and returns no value. It has no side effects;
 * the unequal literal values exist only to make the stable CI job fail.
 */
test('blocks merging when the required CI check fails', () => {
  expect('intentional-required-check-failure').toBe('required-check-success');
});
