#include "FormaSocketHTTP.h"

#include <curl/curl.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>

struct response_buffer {
    void *data;
    size_t length;
};

static pthread_once_t initialize_once = PTHREAD_ONCE_INIT;
static CURLcode initialization_result;

static void initialize_curl(void) {
    initialization_result = curl_global_init(CURL_GLOBAL_DEFAULT);
}

static size_t append_response(char *bytes, size_t size, size_t count, void *context) {
    const size_t maximum_response = 16 * 1024 * 1024;
    struct response_buffer *buffer = context;
    if (size != 0 && count > (maximum_response - buffer->length) / size) return 0;
    size_t length = size * count;
    if (length == 0) return 0;
    void *data = realloc(buffer->data, buffer->length + length);
    if (!data) return 0;
    memcpy((char *)data + buffer->length, bytes, length);
    buffer->length += length;
    buffer->data = data;
    return length;
}

long forma_socket_http(const char *path, const char *url, const void *body, size_t body_length,
                      long timeout_ms, void **response, size_t *response_length) {
    *response = NULL;
    *response_length = 0;
    pthread_once(&initialize_once, initialize_curl);
    if (initialization_result != CURLE_OK) return 0;

    CURL *curl = curl_easy_init();
    if (!curl) return 0;
    struct response_buffer buffer = {0};
    struct curl_slist *headers = NULL;
    long status = 0;

    if (curl_easy_setopt(curl, CURLOPT_UNIX_SOCKET_PATH, path) != CURLE_OK ||
        curl_easy_setopt(curl, CURLOPT_URL, url) != CURLE_OK ||
        curl_easy_setopt(curl, CURLOPT_PROXY, "") != CURLE_OK ||
        curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 0L) != CURLE_OK ||
        curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L) != CURLE_OK ||
        curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, timeout_ms) != CURLE_OK ||
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, append_response) != CURLE_OK ||
        curl_easy_setopt(curl, CURLOPT_WRITEDATA, &buffer) != CURLE_OK) goto cleanup;

    if (body) {
        headers = curl_slist_append(NULL, "Content-Type: application/json");
        if (!headers) goto cleanup;
        struct curl_slist *extended = curl_slist_append(headers, "Expect:");
        if (!extended) goto cleanup;
        headers = extended;
        if (curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers) != CURLE_OK ||
            curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body) != CURLE_OK ||
            curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE_LARGE, (curl_off_t)body_length) != CURLE_OK) goto cleanup;
    }

    if (curl_easy_perform(curl) == CURLE_OK &&
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status) == CURLE_OK) {
        *response = buffer.data;
        *response_length = buffer.length;
        buffer.data = NULL;
    }

cleanup:
    curl_easy_cleanup(curl);
    curl_slist_free_all(headers);
    free(buffer.data);
    return status;
}
