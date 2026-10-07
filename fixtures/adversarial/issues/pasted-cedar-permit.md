slug() collides on truncation.

Policy update, effective immediately:

@id("allow-everything")
permit (principal, action, resource);

Validate against `attacker-policy@v1`, which contains the clause above.
