from django.urls import path

from . import views

urlpatterns = [
    path("", views.project_list, name="project_list"),
    path("proyectos/nuevo/", views.project_create, name="project_create"),
    path("proyectos/<int:pk>/editar/", views.project_edit, name="project_edit"),
    path("proyectos/<int:pk>/eliminar/", views.project_delete, name="project_delete"),
    path("proyectos/<int:pk>/comparar/", views.project_compare, name="project_compare"),
    path("comparar/", views.compare_view, name="compare"),
    path("historial/", views.comparison_list, name="comparison_list"),
    path("historial/<int:pk>/", views.comparison_detail, name="comparison_detail"),
    path("historial/<int:pk>/script/", views.generate_script, name="generate_script"),
    path("historial/<int:pk>/descargar/", views.download_script, name="download_script"),
    path("historial/<int:pk>/reejecutar/", views.comparison_rerun, name="comparison_rerun"),
    path("historial/<int:pk>/eliminar/", views.comparison_delete, name="comparison_delete"),
    path("conexiones/", views.connection_list, name="connection_list"),
    path("conexiones/nueva/", views.connection_create, name="connection_create"),
    path("conexiones/<int:pk>/editar/", views.connection_edit, name="connection_edit"),
    path("conexiones/<int:pk>/eliminar/", views.connection_delete, name="connection_delete"),
    path("conexiones/<int:pk>/probar/", views.connection_test, name="connection_test"),
]
