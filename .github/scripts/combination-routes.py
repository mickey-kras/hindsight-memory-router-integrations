"""Print the bank-scoped routes and scopes of the installed router as JSON."""

import json

from memory_router.facade_routes import FACADE_ROUTES
from memory_router.principals import facade_scope

routes = []
for route in FACADE_ROUTES:
    entry = {"method": route.method, "route": route.template, "scope": facade_scope(route)}
    payload_scope = facade_scope(route, query=[("include_payload", "true")])
    if payload_scope != entry["scope"]:
        entry["payloadScope"] = payload_scope
    routes.append(entry)
print(json.dumps(routes))
