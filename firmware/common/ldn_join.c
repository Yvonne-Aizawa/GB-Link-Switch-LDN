#include "ldn_join.h"
#include "ldn_control.h"
#include "ldn_session.h"
#include "ldn_udp.h"
#include "pia_bridge.h"
#include "ldn_wire.h"

#include <stdio.h>
#include <string.h>
#include "esp_timer.h"

/* Bare text would corrupt binary-mode frames. */
#define printf ldn_wire_printf

/* The same steps as the bridge's join (pia_bridge.c): scan until the room is heard,
   associate with its network key, authenticate, then wait for the room to list us. */

enum { JOIN_IDLE, JOIN_SCAN, JOIN_AUTH, JOIN_MEMBER, JOIN_JOINED };

static const unsigned kChannels[] = {1, 6, 11, 2, 3, 4, 5, 7, 8, 9, 10};
#define CHANNEL_COUNT (sizeof(kChannels) / sizeof(kChannels[0]))
#define SCAN_MS 60000
#define AUTH_MS 40000

static struct
{
    int state;
    uint64_t communication_id;
    uint8_t passphrase[LDN_MAX_PASSPHRASE];
    size_t passphrase_len;
    ldn_network_t net;
    ldn_auth_t auth;
    bool have_room, authenticated;
    unsigned channel_index;
    int auth_attempts;
    int64_t next_scan, next_auth, deadline;
    uint8_t our_mac[6];
} j;

static int64_t now_ms(void) { return esp_timer_get_time() / 1000; }

static void hex_of(const uint8_t *data, size_t length, char *out)
{
    static const char digits[] = "0123456789abcdef";
    for (size_t i = 0; i < length; ++i) { out[2 * i] = digits[data[i] >> 4]; out[2 * i + 1] = digits[data[i] & 15]; }
    out[2 * length] = 0;
}

static bool parse_hex(const char *text, uint8_t *out, size_t max, size_t *length)
{
    size_t n = strlen(text);
    if (n % 2 || n / 2 > max) return false;
    for (size_t i = 0; i < n; ++i)
    {
        char c = text[i];
        int v = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
        if (v < 0) return false;
        if (i % 2) out[i / 2] |= (uint8_t)v; else out[i / 2] = (uint8_t)(v << 4);
    }
    *length = n / 2;
    return true;
}

static void on_action(const uint8_t source[6], const uint8_t *body, size_t length)
{
    if (j.state != JOIN_AUTH || memcmp(source, j.net.host, 6) != 0) return;
    if (ldn_auth_accept(&j.auth, body, length)) j.authenticated = true;
}

void ldn_join_reset(void)
{
    if (j.state == JOIN_IDLE) return;
    ldn_control_set_action_handler(NULL);
    memset(&j, 0, sizeof(j));
}

bool ldn_join_running(void) { return j.state != JOIN_IDLE; }

static void fail(const char *reason)
{
    printf("LDN_JOIN_FAILED %s\n", reason);
    ldn_join_reset();
    ldn_session_stop();
}

bool ldn_join_command(const char *line)
{
    if (!strcmp(line, "LDN_JOIN_STOP"))
    {
        ldn_join_reset();
        ldn_session_stop();
        printf("LDN_JOIN_STOPPED\n");
        return true;
    }
    if (strncmp(line, "LDN_JOIN ", 9)) return false;
    if (pia_bridge_running()) { printf("LDN_ERROR BRIDGE_OWNS_RADIO\n"); return true; }
    char id[17], text[2 * LDN_MAX_PASSPHRASE + 1], extra;
    uint8_t raw[8], passphrase[LDN_MAX_PASSPHRASE];
    size_t length, passphrase_len;
    if (sscanf(line + 9, "%16s %128s %c", id, text, &extra) != 2 || strlen(id) != 16 ||
        !parse_hex(id, raw, sizeof(raw), &length) ||
        !parse_hex(text, passphrase, sizeof(passphrase), &passphrase_len))
    {
        printf("LDN_ERROR INVALID_JOIN\n");
        return true;
    }
    ldn_join_reset();
    ldn_session_stop();
    memcpy(j.passphrase, passphrase, passphrase_len);
    j.passphrase_len = passphrase_len;
    for (int i = 0; i < 8; ++i) j.communication_id = j.communication_id << 8 | raw[i];
    j.state = JOIN_SCAN;
    j.deadline = now_ms() + SCAN_MS;
    printf("LDN_JOIN_STARTED %016llx\n", (unsigned long long)j.communication_id);
    return true;
}

void ldn_join_room(const ldn_network_t *net)
{
    if (j.state == JOIN_SCAN && !j.have_room)
    {
        if (net->communication_id != j.communication_id) return;
        if (net->policy == 1 || net->member_count >= net->maximum) return;
        j.net = *net;
        j.have_room = true;
        return;
    }
    if (j.state != JOIN_MEMBER || memcmp(net->host, j.net.host, 6) != 0) return;
    const ldn_member_t *us = NULL, *host = NULL;
    for (int i = 0; i < net->member_count; ++i)
    {
        if (memcmp(net->members[i].mac, j.our_mac, 6) == 0) us = &net->members[i];
        if (net->members[i].index == 0) host = &net->members[i];
    }
    if (!us || !host) return;
    j.net = *net;

    char command[64], mac[13];
    snprintf(command, sizeof(command), "LDN_NET %s %s", us->ip, host->ip);
    ldn_udp_command(command, true);
    for (int i = 0; i < net->member_count; ++i)
    {
        if (&net->members[i] == us) continue;
        hex_of(net->members[i].mac, 6, mac);
        snprintf(command, sizeof(command), "LDN_NEIGH %s %s", net->members[i].ip, mac);
        ldn_udp_command(command, true);
    }
    char our_mac[13], host_mac[13];
    hex_of(j.our_mac, 6, our_mac);
    hex_of(host->mac, 6, host_mac);
    /* The name last: it may hold spaces. */
    printf("LDN_JOINED %s %s %s %s %s\n", us->ip, our_mac, host->ip, host_mac, host->name);
    j.state = JOIN_JOINED;
}

void ldn_join_poll(void)
{
    const int64_t now = now_ms();
    switch (j.state)
    {
    case JOIN_SCAN:
        if (j.have_room)
        {
            char ssid[33], key_hex[33], bssid[18];
            uint8_t key[16];
            if (!ldn_keys_network_with(&j.net, j.passphrase, j.passphrase_len, key)) { fail("NO_KEYS"); return; }
            hex_of(j.net.ssid, 16, ssid);
            hex_of(key, 16, key_hex);
            memset(key, 0, sizeof(key));
            snprintf(bssid, sizeof(bssid), "%02x:%02x:%02x:%02x:%02x:%02x",
                     j.net.host[0], j.net.host[1], j.net.host[2], j.net.host[3], j.net.host[4], j.net.host[5]);
            esp_err_t r = ldn_session_configure(ssid, bssid, key_hex, (unsigned)j.net.channel);
            memset(key_hex, 0, sizeof(key_hex));
            if (r != ESP_OK) { j.have_room = false; return; }
            const char *host_name = "";
            for (int i = 0; i < j.net.member_count; ++i)
                if (j.net.members[i].index == 0) host_name = j.net.members[i].name;
            printf("LDN_JOIN_ROOM %d %s\n", j.net.channel, host_name);
            ldn_control_set_action_handler(on_action);
            j.state = JOIN_AUTH;
            j.deadline = now + AUTH_MS;
            return;
        }
        if (now > j.deadline) { fail("NO_ROOM"); return; }
        if (now >= j.next_scan)
        {
            ldn_session_scan(kChannels[j.channel_index]);
            j.channel_index = (j.channel_index + 1) % CHANNEL_COUNT;
            j.next_scan = now + 500;
        }
        return;

    case JOIN_AUTH:
        if (now > j.deadline) { fail(j.auth_attempts ? "REFUSED" : "ASSOCIATION"); return; }
        if (!ldn_control_connected()) return;
        ldn_control_mac(j.our_mac);
        if (j.authenticated)
        {
            ldn_control_set_action_handler(NULL);
            j.state = JOIN_MEMBER;
            return;
        }
        if (now >= j.next_auth && j.auth_attempts < 4)
        {
            if (j.auth_attempts == 0 && !ldn_auth_begin(&j.auth, &j.net)) { fail("AUTH_BUILD"); return; }
            ldn_control_tx_action(j.auth.request, (size_t)j.auth.request_len);
            ++j.auth_attempts;
            j.next_auth = now + 700;
        }
        return;

    case JOIN_MEMBER:
        if (now > j.deadline) fail("MEMBERSHIP");
        return;

    case JOIN_JOINED:
        if (!ldn_control_connected()) fail("LINK_LOST");
        return;
    }
}
