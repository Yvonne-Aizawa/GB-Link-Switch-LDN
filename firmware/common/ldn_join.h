#pragma once
#include <stdbool.h>
#include "ldn_keys.h"

/* LDN_JOIN: joins any game's room as a member, with the stored keys, for a host that
   talks to the game itself over LDN_TAP and LDN_ETH. The host names the communication
   ID and the room's passphrase; it never sees a key. */

/* Handles LDN_JOIN and LDN_JOIN_STOP; false for other commands. */
bool ldn_join_command(const char *line);
/* A decoded advertisement, from the probe loop. */
void ldn_join_room(const ldn_network_t *net);
void ldn_join_poll(void);
/* Forgets the join without touching the radio (the caller resets it). */
void ldn_join_reset(void);
bool ldn_join_running(void);
