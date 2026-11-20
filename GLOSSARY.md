# tokengraph

tokengraph turns the usage that AI coding agents record on the user's machine into a graph, a terminal
view and story cards. These are the words its code and docs use.

## Plan limits

**Usage limit**:
A cap on usage that a provider sets for a subscription plan and enforces itself. tokengraph only shows
what the provider reports; it never computes, estimates or enforces one.
_Avoid_: Quota, rate limit, budget

**Limit window**:
The period a usage limit is measured over, ending at a reset time, such as five hours, seven days or
thirty days.
_Avoid_: Session, period, cycle

**Limit reading**:
The share of one limit window a provider reported as used, kept with when it was read, when the window
resets and where the reading came from. It is never a guess, and it is never lowered or zeroed after the
window resets.
_Avoid_: Remaining tokens, limit estimate, snapshot
