from django import forms

from .models import ComparisonProject, DatabaseConnection


class DatabaseConnectionForm(forms.ModelForm):
    password = forms.CharField(
        label="Contraseña",
        required=False,
        widget=forms.PasswordInput(render_value=True),
    )

    class Meta:
        model = DatabaseConnection
        fields = ["name", "host", "port", "dbname", "user", "password", "schema"]
        widgets = {
            f: forms.TextInput(attrs={"class": "input"})
            for f in ["name", "host", "dbname", "user", "schema"]
        }


class CompareForm(forms.Form):
    """Selecciona BD1 (destino) y BD2 (referencia)."""

    db1 = forms.ModelChoiceField(
        queryset=DatabaseConnection.objects.all(),
        label="BD1 — Destino (se modificará para igualar a BD2)",
    )
    db2 = forms.ModelChoiceField(
        queryset=DatabaseConnection.objects.all(),
        label="BD2 — Referencia (estructura deseada)",
    )

    def clean(self):
        cleaned = super().clean()
        if cleaned.get("db1") and cleaned.get("db1") == cleaned.get("db2"):
            raise forms.ValidationError("Selecciona dos bases de datos distintas.")
        return cleaned


class ComparisonProjectForm(forms.ModelForm):
    class Meta:
        model = ComparisonProject
        fields = ["name", "db1", "db2"]

    def clean(self):
        cleaned = super().clean()
        if cleaned.get("db1") and cleaned.get("db1") == cleaned.get("db2"):
            raise forms.ValidationError("Selecciona dos bases de datos distintas.")
        return cleaned
