from django.contrib import messages
from django.http import HttpResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.views.decorators.http import require_POST

from . import diff, introspect
from .forms import ComparisonProjectForm, CompareForm, DatabaseConnectionForm
from .models import ComparisonProject, ComparisonRun, DatabaseConnection


def connection_list(request):
    connections = DatabaseConnection.objects.all()
    return render(request, "comparator/connection_list.html", {"connections": connections})


def _test_unsaved(form):
    """Prueba la conexión con los datos del formulario sin guardarlos."""
    conn = form.save(commit=False)
    return conn.test_connection()


def connection_create(request):
    form = DatabaseConnectionForm(request.POST or None)
    if request.method == "POST" and form.is_valid():
        if "test" in request.POST:
            ok, msg = _test_unsaved(form)
            (messages.success if ok else messages.error)(request, msg)
        else:
            form.save()
            messages.success(request, "Conexión guardada.")
            return redirect("connection_list")
    return render(request, "comparator/connection_form.html", {"form": form, "titulo": "Nueva conexión"})


def connection_edit(request, pk):
    conn = get_object_or_404(DatabaseConnection, pk=pk)
    form = DatabaseConnectionForm(request.POST or None, instance=conn)
    if request.method == "POST" and form.is_valid():
        if "test" in request.POST:
            ok, msg = _test_unsaved(form)
            (messages.success if ok else messages.error)(request, msg)
        else:
            form.save()
            messages.success(request, "Conexión actualizada.")
            return redirect("connection_list")
    return render(request, "comparator/connection_form.html", {"form": form, "titulo": "Editar conexión"})


def connection_delete(request, pk):
    conn = get_object_or_404(DatabaseConnection, pk=pk)
    if request.method == "POST":
        conn.delete()
        messages.success(request, "Conexión eliminada.")
        return redirect("connection_list")
    return render(request, "comparator/connection_confirm_delete.html", {"conn": conn})


def connection_test(request, pk):
    conn = get_object_or_404(DatabaseConnection, pk=pk)
    ok, msg = conn.test_connection()
    if ok:
        messages.success(request, f"{conn.name}: {msg}")
    else:
        messages.error(request, f"{conn.name}: {msg}")
    return redirect("connection_list")


def run_comparison(db1, db2, project=None):
    """Introspecta ambas bases, calcula el diff y guarda un ComparisonRun.

    db1 = destino, db2 = referencia. Devuelve el run creado.
    """
    schema_target = introspect.introspect(db1)   # BD1
    schema_source = introspect.introspect(db2)   # BD2
    result = diff.compare(
        source=schema_source, target=schema_target,
        db1_name=db1.name, db2_name=db2.name,
    )
    return ComparisonRun.objects.create(
        project=project,
        db1_conn=db1,
        db2_conn=db2,
        db1_name=db1.name,
        db2_name=db2.name,
        db1_schema=db1.schema,
        total_changes=result["total_changes"],
        rows=result["rows"],
        sql_by_id=result["sql_by_id"],
    )


def compare_view(request):
    form = CompareForm(request.POST or None)
    context = {"form": form}
    if request.method == "POST" and form.is_valid():
        try:
            run = run_comparison(form.cleaned_data["db1"], form.cleaned_data["db2"])
        except Exception as exc:  # noqa: BLE001
            messages.error(request, f"Error al conectar/introspeccionar: {exc}")
            return render(request, "comparator/compare_form.html", context)
        return redirect("comparison_detail", pk=run.pk)
    return render(request, "comparator/compare_form.html", context)


def _run_context(run):
    return {
        "run": run,
        "result": {
            "rows": run.rows,
            "sql_by_id": run.sql_by_id,
            "total_changes": run.total_changes,
        },
        "db1": run.db1_name,
        "db2": run.db2_name,
    }


def comparison_list(request):
    runs = ComparisonRun.objects.select_related("project").all()
    project = None
    project_id = request.GET.get("project")
    if project_id:
        project = get_object_or_404(ComparisonProject, pk=project_id)
        runs = runs.filter(project=project)
    return render(request, "comparator/comparison_list.html", {"runs": runs, "project": project})


def comparison_detail(request, pk):
    run = get_object_or_404(ComparisonRun, pk=pk)
    context = _run_context(run)
    # Si ya se generó un script antes, lo mostramos con su selección guardada.
    if run.script:
        context.update({
            "selected_ids": run.selected_ids,
            "script": run.script,
            "selected_count": len(run.selected_ids),
        })
    else:
        context["selected_ids"] = None  # todos marcados por defecto
    return render(request, "comparator/compare_result.html", context)


@require_POST
def generate_script(request, pk):
    """Arma el script SQL solo con los cambios seleccionados y lo guarda."""
    run = get_object_or_404(ComparisonRun, pk=pk)
    selected_ids = request.POST.getlist("changes")
    script = diff.build_script(
        run.db1_name, run.db2_name, run.sql_by_id, selected_ids,
        schema=run.db1_schema,
    )

    run.script = script
    run.selected_ids = selected_ids
    run.save(update_fields=["script", "selected_ids"])

    context = _run_context(run)
    context.update({
        "selected_ids": selected_ids,
        "script": script,
        "selected_count": len(selected_ids),
        "just_generated": True,
    })
    return render(request, "comparator/compare_result.html", context)


def download_script(request, pk):
    run = get_object_or_404(ComparisonRun, pk=pk)
    if not run.script:
        messages.error(request, "Esta comparación aún no tiene un script generado.")
        return redirect("comparison_detail", pk=pk)
    response = HttpResponse(run.script, content_type="application/sql")
    response["Content-Disposition"] = f'attachment; filename="alter_script_{run.pk}.sql"'
    return response


def comparison_delete(request, pk):
    run = get_object_or_404(ComparisonRun, pk=pk)
    if request.method == "POST":
        run.delete()
        messages.success(request, "Comparación eliminada del historial.")
        return redirect("comparison_list")
    return render(request, "comparator/comparison_confirm_delete.html", {"run": run})


def comparison_rerun(request, pk):
    """Repite la comparación sobre las mismas bases, creando un run nuevo."""
    run = get_object_or_404(ComparisonRun, pk=pk)
    db1, db2 = run.rerun_pair()
    if not (db1 and db2):
        messages.error(request, "No se puede re-ejecutar: las conexiones originales ya no existen.")
        return redirect("comparison_detail", pk=pk)
    try:
        new_run = run_comparison(db1, db2, project=run.project)
    except Exception as exc:  # noqa: BLE001
        messages.error(request, f"Error al re-ejecutar: {exc}")
        return redirect("comparison_detail", pk=pk)
    messages.success(request, "Comparación re-ejecutada.")
    return redirect("comparison_detail", pk=new_run.pk)


# --- Proyectos de comparación (par configurado una sola vez) -----------

def project_list(request):
    projects = ComparisonProject.objects.select_related("db1", "db2").all()
    project_cards = []
    for p in projects:
        runs = p.runs.all()
        project_cards.append({
            "obj": p,
            "run_count": runs.count(),
            "last_run": runs.first(),  # ordenados por -created_at
        })
    context = {
        "project_cards": project_cards,
        "conn_count": DatabaseConnection.objects.count(),
        "project_count": len(project_cards),
        "run_count": ComparisonRun.objects.count(),
    }
    return render(request, "comparator/project_list.html", context)


def project_create(request):
    form = ComparisonProjectForm(request.POST or None)
    if request.method == "POST" and form.is_valid():
        form.save()
        messages.success(request, "Proyecto de comparación guardado.")
        return redirect("project_list")
    return render(request, "comparator/project_form.html", {"form": form, "titulo": "Nuevo proyecto"})


def project_edit(request, pk):
    project = get_object_or_404(ComparisonProject, pk=pk)
    form = ComparisonProjectForm(request.POST or None, instance=project)
    if request.method == "POST" and form.is_valid():
        form.save()
        messages.success(request, "Proyecto actualizado.")
        return redirect("project_list")
    return render(request, "comparator/project_form.html", {"form": form, "titulo": "Editar proyecto"})


def project_delete(request, pk):
    project = get_object_or_404(ComparisonProject, pk=pk)
    if request.method == "POST":
        project.delete()
        messages.success(request, "Proyecto eliminado.")
        return redirect("project_list")
    return render(request, "comparator/project_confirm_delete.html", {"project": project})


def project_compare(request, pk):
    """Genera una comparación nueva usando el par ya configurado del proyecto."""
    project = get_object_or_404(ComparisonProject, pk=pk)
    try:
        run = run_comparison(project.db1, project.db2, project=project)
    except Exception as exc:  # noqa: BLE001
        messages.error(request, f"Error al comparar: {exc}")
        return redirect("project_list")
    return redirect("comparison_detail", pk=run.pk)
