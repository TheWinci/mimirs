/** Coordinates work. */
struct Coordinator {
    /** Current state. */
    int state;
};

/** Returns whether the coordinator is ready. */
int coordinator_ready(struct Coordinator *coordinator) {
    // Delegate the policy to one place.
    return check_state(coordinator->state);
}
