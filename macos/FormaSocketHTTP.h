#include <stddef.h>

/* Returns zero on failure. The caller owns the returned response bytes. */
long forma_socket_http(const char *path, const char *url, const void *body, size_t body_length,
                      long timeout_ms, void **response, size_t *response_length);
