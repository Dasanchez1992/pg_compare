from django.contrib import admin

from .models import ComparisonProject, ComparisonRun, DatabaseConnection


@admin.register(ComparisonProject)
class ComparisonProjectAdmin(admin.ModelAdmin):
    list_display = ("name", "db1", "db2", "created_at")


@admin.register(DatabaseConnection)
class DatabaseConnectionAdmin(admin.ModelAdmin):
    list_display = ("name", "host", "port", "dbname", "user", "schema")
    search_fields = ("name", "dbname", "host")


@admin.register(ComparisonRun)
class ComparisonRunAdmin(admin.ModelAdmin):
    list_display = ("created_at", "db1_name", "db2_name", "total_changes")
    list_filter = ("db1_name", "db2_name")
    readonly_fields = ("created_at",)
