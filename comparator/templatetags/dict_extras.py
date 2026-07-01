from django import template

register = template.Library()


@register.filter
def dictkey(d, key):
    """Accede a un dict por una clave dinámica: {{ midict|dictkey:variable }}."""
    if hasattr(d, "get"):
        return d.get(key)
    return None
