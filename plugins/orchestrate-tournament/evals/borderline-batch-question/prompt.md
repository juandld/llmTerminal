I've got three tiny config files and I want to know if they agree with each other before I ship:

`service-a.env`:
```
TIMEOUT_MS=5000
RETRY_COUNT=3
LOG_LEVEL=info
```

`service-b.env`:
```
TIMEOUT_MS=5000
RETRY_COUNT=5
LOG_LEVEL=info
```

`service-c.env`:
```
TIMEOUT_MS=3000
RETRY_COUNT=3
LOG_LEVEL=debug
```

All three call the same downstream API and are supposed to behave
consistently. Tell me where they disagree and which one you'd fix to match
the other two.
